import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import Darwin

struct Request: Decodable {
    let outputDir: String
    let windowId: UInt32?
    let displayId: UInt32?
    let pid: Int32?
    let bundle: String?
    let launchDate: Double?
    let maxDurationSeconds: Double
}
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}
func failure(_ message: String) -> NSError { NSError(domain: "OpenBotRecording", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }

func processBirth(_ pid: Int32) -> Double? {
    var info = proc_bsdinfo()
    let count = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, count) == count,
          info.pbi_pid == UInt32(pid) else { return nil }
    return Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
}

// Audio callbacks run on a dedicated queue; only counts and durations cross it.
final class AudioEvidence: @unchecked Sendable {
    private let lock = NSLock()
    private var system = 0
    private var microphone = 0
    private var systemSeconds = 0.0
    private var microphoneSeconds = 0.0
    func add(_ sample: CMSampleBuffer, microphone isMicrophone: Bool) {
        guard CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              CMSampleBufferGetNumSamples(sample) > 0,
              let format = CMSampleBufferGetFormatDescription(sample),
              CMFormatDescriptionGetMediaType(format) == kCMMediaType_Audio,
              CMSampleBufferGetPresentationTimeStamp(sample).isValid,
              let data = CMSampleBufferGetDataBuffer(sample), CMBlockBufferGetDataLength(data) > 0,
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format),
              description.pointee.mSampleRate.isFinite, description.pointee.mSampleRate > 0 else { return }
        let duration = Double(CMSampleBufferGetNumSamples(sample)) / description.pointee.mSampleRate
        lock.lock(); defer { lock.unlock() }
        if isMicrophone { microphone += CMSampleBufferGetNumSamples(sample); if duration.isFinite && duration > 0 { microphoneSeconds += duration } }
        else { system += CMSampleBufferGetNumSamples(sample); if duration.isFinite && duration > 0 { systemSeconds += duration } }
    }
    func snapshot() -> (Int, Int, Double, Double) {
        lock.lock(); defer { lock.unlock() }
        return (system, microphone, systemSeconds, microphoneSeconds)
    }
}

final class VideoClock: @unchecked Sendable {
    private let lock = NSLock()
    private var first: CMTime?
    func observe(_ sample: CMSampleBuffer) {
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        guard time.isValid, time.seconds.isFinite,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue else { return }
        lock.lock(); defer { lock.unlock() }; if first == nil { first = time }
    }
    func value() -> CMTime? { lock.lock(); defer { lock.unlock() }; return first }
}
// Receives AUDIO ONLY from a full-display filter. Never adds a screen output or
// recording output to that stream; no auxiliary display pixels are delivered/saved.
final class SystemAudioFile: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue: DispatchQueue
    let evidence: AudioEvidence
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    var firstPTS: CMTime?
    var writeError: Error?
    var ended = false
    init(url: URL, queue: DispatchQueue, evidence: AudioEvidence) throws {
        self.queue = queue; self.evidence = evidence
        writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128000])
        input.expectsMediaDataInRealTime = true
        super.init()
        guard writer.canAdd(input) else { throw failure("无法建立全系统音频编码器") }; writer.add(input)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, !ended, writeError == nil,
              CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer),
              CMSampleBufferGetNumSamples(sampleBuffer) > 0,
              CMSampleBufferGetDataBuffer(sampleBuffer) != nil else { return }
        evidence.add(sampleBuffer, microphone: false)
        if firstPTS == nil {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard pts.isValid, pts.seconds.isFinite, writer.startWriting() else { writeError = writer.error ?? failure("全系统音频编码器无法启动"); return }
            firstPTS = pts; writer.startSession(atSourceTime: pts)
        }
        guard input.isReadyForMoreMediaData else { writeError = failure("全系统音频编码发生背压，录屏未保存"); return }
        if !input.append(sampleBuffer) { writeError = writer.error ?? failure("全系统音频保存失败") }
    }
    func finish() async throws -> CMTime {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.ended = true
                if let error = self.writeError { self.writer.cancelWriting(); continuation.resume(throwing: error); return }
                guard let first = self.firstPTS else { self.writer.cancelWriting(); continuation.resume(throwing: failure("全系统音频未产生样本")); return }
                self.input.markAsFinished()
                self.writer.finishWriting {
                    if self.writer.status == .completed { continuation.resume(returning: first) }
                    else { continuation.resume(throwing: self.writer.error ?? failure("全系统音频文件未完成")) }
                }
            }
        }
    }
}

@available(macOS 15.0, *)
@MainActor final class Recorder: NSObject, SCRecordingOutputDelegate, SCStreamDelegate, SCStreamOutput {
    let request: Request
    nonisolated let audioEvidence = AudioEvidence()
    nonisolated let videoClock = VideoClock()
    let audioQueue = DispatchQueue(label: "openbot.recording.audio-evidence")
    var stream: SCStream?
    var output: SCRecordingOutput?
    var systemStream: SCStream?
    var systemAudio: SystemAudioFile?
    var audioStop: Task<CMTime?, Error>?
    var exporter: AVAssetExportSession?
    var exportWatchdog: Task<Void, Never>?
    var stopping = false
    var completed = false
    var started = false
    var stopReason = "manual"
    var terminalError: Error?
    var watchdog: Task<Void, Never>?
    var signalSources: [DispatchSourceSignal] = []
    var startTime = Date()
    var frozenBundle: String?
    var frozenBirth: Double?
    init(_ request: Request) { self.request = request }
    var directory: URL { URL(fileURLWithPath: request.outputDir, isDirectory: true) }
    var video: URL { directory.appendingPathComponent("recording.mp4") }
    var rawVideo: URL { request.windowId == nil ? video : directory.appendingPathComponent("window-input.mp4") }
    var systemFile: URL { directory.appendingPathComponent("system-input.m4a") }
    func diskBytes() -> Int64 {
        [video, rawVideo, systemFile].reduce(into: (Set<String>(), Int64(0))) { state, url in
            if state.0.insert(url.path).inserted { state.1 += ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0) }
        }.1
    }
    func validate() throws {
        guard CGPreflightScreenCaptureAccess(), AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw failure("需要屏幕录制和麦克风权限；请在系统设置授权后重试")
        }
        if let id = request.windowId {
            guard let pid = request.pid, let bundle = frozenBundle ?? request.bundle, let birth = frozenBirth ?? request.launchDate,
                  let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
                  (app.bundleIdentifier ?? "") == bundle, let actualBirth = processBirth(pid),
                  abs(actualBirth - birth) < 0.000001,
                  let windows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]],
                  windows.contains(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }) else {
                throw failure("所选应用窗口已关闭或身份已改变")
            }
        } else if let id = request.displayId {
            guard NSScreen.screens.contains(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }) else { throw failure("所选屏幕已断开") }
        } else { throw failure("录屏目标无效") }
    }
    func run() async {
        do {
            umask(0o077)
            if let pid = request.pid, let app = NSRunningApplication(processIdentifier: pid) {
                frozenBundle = request.bundle ?? app.bundleIdentifier ?? ""
                frozenBirth = request.launchDate ?? processBirth(pid)
            }
            try validate()
            guard request.maxDurationSeconds > 0, request.maxDurationSeconds <= 180,
                  directory.path.hasPrefix("/"), !FileManager.default.fileExists(atPath: video.path) else { throw failure("录屏输出或时限无效") }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            try validate()
            let filter: SCContentFilter
            let frame: CGRect
            if let id = request.windowId {
                guard let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == request.pid }) else { throw failure("所选窗口不可录制") }
                filter = SCContentFilter(desktopIndependentWindow: window); frame = window.frame
            } else {
                guard let display = content.displays.first(where: { $0.displayID == request.displayId }) else { throw failure("所选屏幕不可录制") }
                filter = SCContentFilter(display: display, excludingWindows: []); frame = display.frame
            }
            let config = SCStreamConfiguration()
            let scale = min(1, 1920 / max(frame.width, frame.height))
            config.width = max(2, Int(frame.width * scale) / 2 * 2)
            config.height = max(2, Int(frame.height * scale) / 2 * 2)
            config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
            config.queueDepth = 3
            config.capturesAudio = request.windowId == nil
            config.excludesCurrentProcessAudio = false
            config.captureMicrophone = true
            config.showsCursor = true
            let recordingConfig = SCRecordingOutputConfiguration()
            recordingConfig.outputURL = rawVideo
            recordingConfig.videoCodecType = .h264
            recordingConfig.outputFileType = .mp4
            let output = SCRecordingOutput(configuration: recordingConfig, delegate: self)
            self.output = output
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            self.stream = stream
            if request.windowId == nil { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
            else {
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: audioQueue)
                guard let display = content.displays.first else { throw failure("没有可用屏幕供全系统声音采集") }
                let audioConfig = SCStreamConfiguration()
                audioConfig.capturesAudio = true; audioConfig.excludesCurrentProcessAudio = false
                audioConfig.captureMicrophone = false
                audioConfig.sampleRate = 48000; audioConfig.channelCount = 2
                audioConfig.width = 2; audioConfig.height = 2; audioConfig.queueDepth = 3
                let audioStream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: audioConfig, delegate: self)
                let audioFile = try SystemAudioFile(url: systemFile, queue: audioQueue, evidence: audioEvidence)
                self.systemStream = audioStream; self.systemAudio = audioFile
                try audioStream.addStreamOutput(audioFile, type: .audio, sampleHandlerQueue: audioQueue)
            }
            try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: audioQueue)
            try stream.addRecordingOutput(output)
            installControl()
            try await systemStream?.startCapture()
            try await stream.startCapture()
            if stopping { try? await stream.stopCapture() }
        } catch { await fail(error) }
    }
    func installControl() {
        // EOF closes collection if the parent dies; commands and input are bounded.
        DispatchQueue.global().async {
            var buffer = Data()
            while true {
                let data = FileHandle.standardInput.availableData
                if data.isEmpty { Task { @MainActor in await self.stop("parent-exit", cancelled: true) }; return }
                buffer.append(data)
                if buffer.count > 1024 { Task { @MainActor in await self.stop("invalid-command", cancelled: true) }; return }
                while let end = buffer.firstIndex(of: 10) {
                    let line = String(data: buffer[..<end], encoding: .utf8) ?? ""
                    buffer.removeSubrange(...end)
                    Task { @MainActor in
                        if line == "stop" { await self.stop("manual") }
                        else { await self.stop("cancelled", cancelled: true) }
                    }
                }
            }
        }
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { Task { @MainActor in await self.stop("cancelled", cancelled: true) } }
            source.resume(); signalSources.append(source)
        }
        watchdog = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
                guard let self, !self.stopping, !self.completed else { return }
                do { try self.validate() } catch { await self.fail(error); return }
                if self.started && (self.output?.recordedDuration.seconds ?? Date().timeIntervalSince(self.startTime)) >= max(0.1, self.request.maxDurationSeconds - 0.4) {
                    await self.stop("time-limit"); return
                }
                // Leave finalization headroom under the hard 128 MiB result cap.
                if self.diskBytes() >= (self.request.windowId == nil ? 120 : 56) * 1024 * 1024 {
                    await self.stop("size-limit"); return
                }
            }
        }
    }

    func stop(_ reason: String, cancelled: Bool = false) async {
        if completed { return }
        if cancelled { terminalError = failure("录屏已取消"); exporter?.cancelExport() }
        if stopping { return }
        stopping = true; stopReason = reason; watchdog?.cancel()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 90_000_000_000)
            if !self.completed { self.completeError(failure("录屏文件结束超时")) }
        }
        beginAudioStop()
        do { try await stream?.stopCapture() } catch {
            _ = try? await audioStop?.value; completeError(error)
        }
    }
    func beginAudioStop() {
        guard audioStop == nil else { return }
        audioStop = Task {
            try await self.systemStream?.stopCapture()
            return try await self.systemAudio?.finish()
        }
    }
    func fail(_ error: Error) async {
        terminalError = error
        if stream == nil { completeError(error) } else { await stop("error") }
    }
    func completeError(_ error: Error) {
        guard !completed else { return }; completed = true; watchdog?.cancel(); exportWatchdog?.cancel(); exporter?.cancelExport()
        for file in [video, rawVideo, systemFile] { try? FileManager.default.removeItem(at: file) }
        for index in 0..<6 { try? FileManager.default.removeItem(at: directory.appendingPathComponent("frame-\(index).jpg")) }
        emit(["type": "error", "message": error.localizedDescription]); exit(1)
    }
    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        if outputType == .screen { videoClock.observe(sampleBuffer) }
        else if outputType == .audio { audioEvidence.add(sampleBuffer, microphone: false) }
        else if outputType == .microphone { audioEvidence.add(sampleBuffer, microphone: true) }
    }
    nonisolated func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        Task { @MainActor in
            do { try self.validate() } catch { await self.fail(error); return }
            self.started = true; self.startTime = Date(); emit(["type": "started"])
        }
    }
    nonisolated func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        Task { @MainActor in await self.fail(error) }
    }
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in await self.fail(error) }
    }
    nonisolated func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        Task { @MainActor in await self.finish() }
    }
    func mixSystemAudio(systemPTS: CMTime, videoPTS: CMTime) async throws {
        let raw = AVURLAsset(url: rawVideo), global = AVURLAsset(url: systemFile)
        let duration = try await raw.load(.duration)
        let videos = try await raw.loadTracks(withMediaType: .video)
        let microphones = try await raw.loadTracks(withMediaType: .audio)
        let systems = try await global.loadTracks(withMediaType: .audio)
        guard let sourceVideo = videos.first, let systemTrack = systems.first, !microphones.isEmpty else { throw failure("混音缺少窗口视频、麦克风或全系统音轨") }
        let composition = AVMutableComposition()
        guard let targetVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw failure("无法建立视频轨道") }
        try targetVideo.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceVideo, at: .zero)
        targetVideo.preferredTransform = try await sourceVideo.load(.preferredTransform)
        var parameters: [AVAudioMixInputParameters] = []
        for track in microphones {
            guard let destination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw failure("无法建立麦克风轨道") }
            let range = try await track.load(.timeRange)
            // Preserve the microphone track's original offset in the recording.
            // Inserting a late-starting track at zero would advance its sound.
            let insertion = CMTimeMaximum(.zero, range.start)
            let length = CMTimeMinimum(CMTimeSubtract(CMTimeRangeGetEnd(range), insertion), CMTimeSubtract(duration, insertion))
            guard length.seconds.isFinite, length.seconds > 0 else { throw failure("麦克风音轨未覆盖视频时间区间") }
            try destination.insertTimeRange(CMTimeRange(start: insertion, duration: length), of: track, at: insertion)
            let parameter = AVMutableAudioMixInputParameters(track: destination); parameter.setVolume(1, at: .zero); parameters.append(parameter)
        }
        let delta = CMTimeSubtract(systemPTS, videoPTS).seconds
        guard delta.isFinite, abs(delta) < 20 else { throw failure("全系统声音与视频时间戳无法对齐") }
        let sourceStart = CMTime(seconds: max(0, -delta), preferredTimescale: 48000)
        let insertion = CMTime(seconds: max(0, delta), preferredTimescale: 48000)
        let globalRange = try await systemTrack.load(.timeRange)
        let length = CMTimeMinimum(CMTimeSubtract(globalRange.duration, sourceStart), CMTimeSubtract(duration, insertion))
        guard length.seconds > 0, let destination = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw failure("全系统声音未覆盖视频时间区间") }
        try destination.insertTimeRange(CMTimeRange(start: CMTimeAdd(globalRange.start, sourceStart), duration: length), of: systemTrack, at: insertion)
        let parameter = AVMutableAudioMixInputParameters(track: destination); parameter.setVolume(1, at: .zero); parameters.append(parameter)
        let mix = AVMutableAudioMix(); mix.inputParameters = parameters
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { throw failure("无法建立混音导出器") }
        self.exporter = exporter
        exporter.audioMix = mix
        exporter.timeRange = CMTimeRange(start: .zero, duration: duration)
        exportWatchdog = Task { @MainActor in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
                do { try self.validate(); if self.diskBytes() > 128 * 1024 * 1024 { throw failure("录屏临时文件超过128MiB") } }
                catch { self.terminalError = error; exporter.cancelExport(); return }
            }
        }
        defer { exportWatchdog?.cancel(); self.exporter = nil }
        do { try await exporter.export(to: video, as: .mp4) }
        catch { throw terminalError ?? error }
        if let error = terminalError { throw error }
        try FileManager.default.removeItem(at: rawVideo); try FileManager.default.removeItem(at: systemFile)
    }
    func finish() async {
        do {
            beginAudioStop()
            let systemPTS = try await audioStop?.value
            if let error = terminalError { throw error }
            try validate()
            if request.windowId != nil {
                guard let audioPTS = systemPTS ?? nil, let videoPTS = videoClock.value() else { throw failure("音视频缺少共同host时间戳") }
                try await mixSystemAudio(systemPTS: audioPTS, videoPTS: videoPTS)
            }
            let asset = AVURLAsset(url: video)
            let duration = try await asset.load(.duration).seconds
            let tracks = try await asset.loadTracks(withMediaType: .video)
            let audio = try await asset.loadTracks(withMediaType: .audio)
            guard let track = tracks.first, !audio.isEmpty, duration.isFinite, duration > 0, duration <= 180 else { throw failure("录屏文件缺少有效视频或音频") }
            // Drain callbacks queued before finalization before asserting both sources.
            await withCheckedContinuation { continuation in audioQueue.async { continuation.resume() } }
            let evidence = audioEvidence.snapshot()
            guard evidence.0 > 0, evidence.1 > 0, evidence.2 > 0, evidence.3 > 0 else { throw failure("系统声音或麦克风未产生有效音频样本，录屏未保存") }
            let size = try await track.load(.naturalSize)
            let attrs = try FileManager.default.attributesOfItem(atPath: video.path)
            guard (attrs[.size] as? NSNumber)?.intValue ?? Int.max <= 128 * 1024 * 1024 else { throw failure("录屏文件超过128MiB") }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: video.path)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1280, height: 1280)
            // Seek to the requested sample, allowing at most the next video frame.
            // Unlimited default tolerance can repeatedly return the first keyframe.
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 15)
            var frames: [[String: Any]] = []
            let frameCount = min(6, max(1, Int((duration * 15).rounded(.down))))
            for index in 0..<frameCount {
                let seconds = duration * Double(index) / Double(frameCount)
                let (image, actual) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
                guard actual.seconds.isFinite, actual.seconds >= 0 else { throw failure("视频帧时间无效") }
                // A very short or sparse video can contain fewer than six distinct
                // samples. Never present copies of one keyframe as separate moments.
                if let previous = frames.last?["atSeconds"] as? Double, actual.seconds <= previous { continue }
                let file = directory.appendingPathComponent("frame-\(index).jpg")
                guard let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw failure("无法抽取视频帧") }
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { throw failure("视频帧保存失败") }
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                frames.append(["path": file.path, "atSeconds": max(0, actual.seconds)])
            }
            guard !frames.isEmpty else { throw failure("未能抽取有效视频帧") }
            try validate()
            if let error = terminalError { throw error }
            guard !completed else { return }; completed = true
            emit(["type": "finished", "result": ["videoPath": video.path, "width": Int(size.width), "height": Int(size.height), "durationSeconds": duration, "frames": frames, "audio": ["system": true, "microphone": true], "audioSampleCounts": ["system": evidence.0, "microphone": evidence.1], "audioSampleDurationSeconds": ["system": evidence.2, "microphone": evidence.3], "audioTrackCount": audio.count, "systemAudioScope": "system-wide", "stopReason": stopReason]])
            exit(0)
        } catch { completeError(error) }
    }
}
@main struct Main {
    static func main() async {
        guard #available(macOS 15.0, *) else { emit(["type": "error", "message": "录屏需要macOS15或更新版本"]); exit(1) }
        do {
            guard CommandLine.arguments.count == 2, CommandLine.arguments[1].utf8.count < 8192 else { throw failure("录屏请求无效") }
            let request = try JSONDecoder().decode(Request.self, from: Data(CommandLine.arguments[1].utf8))
            let recorder = Recorder(request)
            await recorder.run()
            while !recorder.completed { try? await Task.sleep(nanoseconds: 1_000_000_000) }
        } catch { emit(["type": "error", "message": error.localizedDescription]); exit(1) }
    }
}
