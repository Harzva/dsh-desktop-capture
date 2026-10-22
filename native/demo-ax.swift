import Foundation
import AppKit
import ApplicationServices
import Darwin

// Public AX API only. Private newline-delimited stdio; stdout is protocol-only.
struct Failure: Error {
    let code: String; let text: String; let effect: String; let fence: Bool; let evidence: [String: Any]?
    init(_ code: String, _ text: String, effect: String = "none", fence: Bool = false, evidence: [String: Any]? = nil) {
        self.code = code; self.text = text; self.effect = effect; self.fence = fence; self.evidence = evidence
    }
}
struct Budget {
    let deadline: Double
    init(_ seconds: Double = 3) { deadline = ProcessInfo.processInfo.systemUptime + seconds }
    func check() throws { if ProcessInfo.processInfo.systemUptime > deadline { throw Failure("native_timeout", "AX read budget exceeded") } }
}
func exact(_ o: [String: Any], _ required: [String]) throws {
    guard Set(o.keys) == Set(required) else { throw Failure("invalid_request", "Unknown or missing fields") }
}
func object(_ value: Any?) throws -> [String: Any] {
    guard let value = value as? [String: Any] else { throw Failure("invalid_request", "Object required") }; return value
}
func text(_ value: Any?, _ max: Int = 256) throws -> String {
    guard let s = value as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, s.count <= max else { throw Failure("invalid_request", "Bounded string required") }; return s
}
func integer(_ value: Any?, _ min: Int, _ max: Int) throws -> Int {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
          n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= Double(min), n.doubleValue <= Double(max) else { throw Failure("invalid_request", "Bounded integer required") }; return n.intValue
}
func processBirth(_ pid: Int32) -> Double? {
    var info = proc_bsdinfo(); let count = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, count) == count, info.pbi_pid == UInt32(pid) else { return nil }
    return Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
}
func birthString(_ value: Double) -> String { String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), value) }
// Fixed public semantic fields only. Preserve JSON primitive types; never stringify unknown AX objects.
func semanticField(_ error: AXError, _ value: CFTypeRef?) -> [String: Any] {
    var result: [String: Any] = ["read": true, "axError": error.rawValue]
    guard error == .success else {
        result["status"] = error == .attributeUnsupported ? "unsupported" : "unavailable"
        return result
    }
    guard let value else { result["status"] = "unavailable"; result["type"] = "missing"; return result }
    let type = CFGetTypeID(value)
    if type == CFStringGetTypeID(), let string = value as? String {
        let bounded = String(string.unicodeScalars.prefix(256))
        result["status"] = "available"; result["type"] = "string"; result["value"] = bounded
        result["truncated"] = CFStringGetLength(string as CFString) > bounded.utf16.count
    } else if type == CFBooleanGetTypeID(), let number = value as? NSNumber {
        result["status"] = "available"; result["type"] = "boolean"; result["value"] = number.boolValue
    } else if type == CFNumberGetTypeID(), let number = value as? NSNumber {
        result["type"] = "number"; result["numberEncoding"] = String(cString: number.objCType)
        if number.doubleValue.isFinite { result["status"] = "available"; result["value"] = number }
        else { result["status"] = "unsupported_value"; result["reason"] = "nonfinite" }
    } else {
        result["status"] = "unsupported_type"; result["type"] = "other"; result["cfTypeId"] = type
    }
    return result
}
func cgWindows() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
}
func cgFrame(_ row: [String: Any]) -> CGRect? {
    guard let bounds = row[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return CGRect(dictionaryRepresentation: bounds as CFDictionary)
}
func matches(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.origin.x-b.origin.x) <= 2 && abs(a.origin.y-b.origin.y) <= 2 && abs(a.width-b.width) <= 2 && abs(a.height-b.height) <= 2
}
struct Target {
    let raw: [String: Any]; let bundleId: String; let pid: Int32; let birth: Double; let windowId: UInt32
    init(_ input: [String: Any]) throws {
        try exact(input, ["bundleId", "pid", "processBirth", "windowId"])
        raw = input; bundleId = try text(input["bundleId"]); pid = Int32(try integer(input["pid"], 1, Int(Int32.max)))
        windowId = UInt32(try integer(input["windowId"], 1, Int(UInt32.max)))
        let b = try text(input["processBirth"], 32)
        guard b.range(of: "^\\d{1,12}(\\.\\d{1,6})?$", options: .regularExpression) != nil,
              let parsed = Double(b), parsed.isFinite, parsed > 0 else { throw Failure("invalid_request", "processBirth must be Unix seconds with <=6 decimal places") }
        birth = parsed
    }
}
// Observation only: never activates/focuses a target or calls AX. Keep the exact identity
// alongside actual process/window facts so a changed response cannot be mistaken for success.
func foregroundEvidence(_ t: Target) -> [String: Any] {
    // AppKit documents these properties update when the main run loop runs.
    // Bounded 1ms pump is observation-only, inside the existing overall budget.
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.001))
    let running = NSRunningApplication(processIdentifier: t.pid), actualBirth = processBirth(t.pid)
    let front = NSWorkspace.shared.frontmostApplication
    let windowExists = cgWindows().contains { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == t.windowId && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == t.pid && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
    return ["target": t.raw, "observedAtMonotonicMs": ProcessInfo.processInfo.systemUptime * 1000,
      "isActive": running?.isActive ?? false, "observedBundleId": running?.bundleIdentifier as Any? ?? NSNull(),
      "observedProcessBirth": actualBirth.map(birthString) as Any? ?? NSNull(), "windowExists": windowExists,
      "identityMatches": actualBirth.map { abs($0-t.birth) < 0.000001 } == true && running?.bundleIdentifier == t.bundleId && running?.isTerminated == false && windowExists,
      "frontmostPID": front.map { Int($0.processIdentifier) } as Any? ?? NSNull(), "frontmostBundleId": front?.bundleIdentifier as Any? ?? NSNull()]
}
// Completion is an observed foreground/focus postcondition, never an API-return inference.
// identityMatches is native evidence derived from live birth/bundle/exact on-screen CG identity.
func activationPostcondition(_ t: Target, _ observed: [String: Any], focusedWindowMatches: Bool) -> Bool {
    focusedWindowMatches && observed["identityMatches"] as? Bool == true && observed["isActive"] as? Bool == true &&
      observed["frontmostPID"] as? Int == Int(t.pid) && observed["frontmostBundleId"] as? String == t.bundleId
}
final class Session {
    var selected: Target?; var window: AXUIElement?; var app: AXUIElement?
    var candidates: [String: AXUIElement] = [:]; let nonce = UUID().uuidString.lowercased(); var next = 0
    var fenced = false; var activationAttempted = false; var activationVerified = false
    func trusted() throws { guard AXIsProcessTrusted() else { throw Failure("permission_denied", "Accessibility authorization is missing; no permission prompt was requested", fence: true) } }
    func attr(_ e: AXUIElement, _ name: String, _ budget: Budget) throws -> (AXError, CFTypeRef?) {
        try budget.check(); AXUIElementSetMessagingTimeout(e, 1.0)
        var value: CFTypeRef?; let error = AXUIElementCopyAttributeValue(e, name as CFString, &value)
        try budget.check(); return (error, value)
    }
    func stringAttr(_ e: AXUIElement, _ name: String, _ budget: Budget) throws -> String? {
        let (err, value) = try attr(e, name, budget); guard err == .success else { return nil }; return value as? String
    }
    func elements(_ e: AXUIElement, _ name: String, limit: Int, budget: Budget, refuseExcess: Bool = false) throws -> ([AXUIElement], Bool) {
        try budget.check(); AXUIElementSetMessagingTimeout(e, 1.0)
        var count: CFIndex = 0; let error = AXUIElementGetAttributeValueCount(e, name as CFString, &count)
        if error == .attributeUnsupported || error == .noValue { return ([], false) }
        guard error == .success, count >= 0 else { throw Failure("ax_read_failed", "AX count unavailable (\(error.rawValue))") }
        if refuseExcess && count > limit { throw Failure("mapping_limit", "Too many AX windows to map safely") }
        let amount = min(count, limit); if amount == 0 { return ([], false) }
        try budget.check(); var array: CFArray?
        let read = AXUIElementCopyAttributeValues(e, name as CFString, 0, amount, &array)
        guard read == .success, let values = array as? [AXUIElement] else { throw Failure("ax_read_failed", "AX array unavailable (\(read.rawValue))") }
        try budget.check(); return (values, count > limit)
    }
    func frame(_ e: AXUIElement, _ b: Budget) throws -> CGRect? {
        let (pe, p) = try attr(e, kAXPositionAttribute, b), (se, s) = try attr(e, kAXSizeAttribute, b)
        guard pe == .success, se == .success, let p, let s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
    func identity(_ t: Target) throws -> [String: Any] {
        guard let actual = processBirth(t.pid), abs(actual-t.birth) < 0.000001,
              let running = NSRunningApplication(processIdentifier: t.pid), !running.isTerminated, running.bundleIdentifier == t.bundleId else {
            throw Failure("target_changed", "Process instance/bundle identity changed", fence: true)
        }
        let rows = cgWindows().filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == t.windowId && ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == t.pid && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 }
        guard rows.count == 1, cgFrame(rows[0]) != nil else { throw Failure("target_changed", "Explicit CG window is no longer uniquely on-screen", fence: true) }
        var row = rows[0]; row["observedProcessBirth"] = birthString(actual); return row
    }
    // Public frame/title mapping only. Titles are live tie-breakers, never persisted identity locks.
    func mappedWindow(_ t: Target, _ application: AXUIElement, _ row: [String: Any], _ b: Budget) throws -> AXUIElement {
        guard let cg = cgFrame(row) else { throw Failure("mapping_failed", "No public CG frame") }
        let (windows, _) = try elements(application, kAXWindowsAttribute, limit: 64, budget: b, refuseExcess: true)
        var matching: [AXUIElement] = []
        for w in windows { if let f = try frame(w, b), matches(f, cg) { matching.append(w) } }
        if matching.count > 1, let cgTitle = row[kCGWindowName as String] as? String, !cgTitle.isEmpty {
            var titled: [AXUIElement] = []
            for w in matching { if try stringAttr(w, kAXTitleAttribute, b) == cgTitle { titled.append(w) } }
            matching = titled
        }
        guard matching.count == 1 else { throw Failure("mapping_ambiguous", "Public frame/title mapping is missing or ambiguous; refusing selection") }
        // Also reject another CG window that could equally own the chosen AX frame/title.
        let framePeers = cgWindows().filter { other in
            guard (other[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == t.pid,
                  (other[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let f = cgFrame(other), matches(f, cg) else { return false }
            return true
        }
        if framePeers.count > 1 {
            guard let title = row[kCGWindowName as String] as? String, !title.isEmpty,
                  try stringAttr(matching[0], kAXTitleAttribute, b) == title,
                  framePeers.filter({ ($0[kCGWindowName as String] as? String) == title }).count == 1 else { throw Failure("mapping_ambiguous", "CG frame/title mapping is not unique") }
        }
        return matching[0]
    }
    func select(_ t: Target, _ b: Budget) throws -> [String: Any] {
        try trusted(); guard selected == nil else { throw Failure("already_selected", "A helper session selects exactly one target") }
        let row = try identity(t), application = AXUIElementCreateApplication(t.pid)
        let w = try mappedWindow(t, application, row, b)
        selected = t; app = application; window = w
        return ["status": "selected", "identity": t.raw, "evidence": ["native": true, "mapping": "public-frame-live-title", "windowId": t.windowId, "processBirth": row["observedProcessBirth"]!] as [String: Any]]
    }
    func validate(_ t: Target, _ b: Budget) throws -> [String: Any] {
        try trusted()
        guard let chosen = selected, NSDictionary(dictionary: t.raw).isEqual(to: chosen.raw), let app, let window else { throw Failure("target_not_selected", "Target must match this explicitly selected helper session") }
        let row = try identity(t), mapped = try mappedWindow(t, app, row, b)
        guard CFEqual(mapped, window) else { throw Failure("target_changed", "AX window reference changed; no automatic replacement", fence: true) }
        return ["status": "pass", "identity": t.raw, "evidence": ["native": true, "windowId": t.windowId, "processBirth": row["observedProcessBirth"]!, "axReferenceHeld": true] as [String: Any]]
    }
    func owned(_ e: AXUIElement, _ b: Budget) throws -> Bool {
        guard let t = selected, let window else { return false }
        var pid: pid_t = 0
        let pidError = AXUIElementGetPid(e, &pid)
        if pidError == .invalidUIElement { return false }
        guard pidError == .success else { throw Failure("ax_read_failed", "AX locator PID unavailable (\(pidError.rawValue))") }
        guard pid == t.pid else { return false }
        var cursor = e
        for _ in 0..<24 {
            if CFEqual(cursor, window) { return true }
            let (we, w) = try attr(cursor, kAXWindowAttribute, b)
            if we == .success, let w, CFGetTypeID(w) == AXUIElementGetTypeID() { return CFEqual(w, window) }
            if we == .invalidUIElement { return false }
            guard we == .attributeUnsupported || we == .noValue else { throw Failure("ax_read_failed", "AX window membership unavailable (\(we.rawValue))") }
            let (pe, parent) = try attr(cursor, kAXParentAttribute, b)
            if pe == .invalidUIElement || pe == .noValue || pe == .attributeUnsupported { return false }
            guard pe == .success, let parent, CFGetTypeID(parent) == AXUIElementGetTypeID() else { throw Failure("ax_read_failed", "AX parent membership unavailable (\(pe.rawValue))") }
            cursor = parent as! AXUIElement
        }
        return false
    }
    func id(_ e: AXUIElement) throws -> String {
        for (id, existing) in candidates where CFEqual(existing, e) { return id }
        guard candidates.count < 1000 else { throw Failure("locator_limit", "Session candidate registry is full; explicit new session required") }
        next += 1; let id = "\(nonce):\(next)"; candidates[id] = e; return id
    }
    func resolve(_ input: Any?, _ b: Budget) throws -> (String, AXUIElement) {
        let l = try object(input); try exact(l, ["id"]); let id = try text(l["id"], 128)
        guard let e = candidates[id], try owned(e, b) else { throw Failure("stale_locator", "Locator is not a live candidate in the selected window") }; return (id, e)
    }
    func secure(_ e: AXUIElement, _ b: Budget) throws -> Bool {
        guard let role = try stringAttr(e, kAXRoleAttribute, b) else { throw Failure("secure_state_unknown", "Candidate role is unavailable") }
        if role == "AXSecureTextField" { return true }
        let (err, value) = try attr(e, kAXSubroleAttribute, b)
        if err == .success, let sub = value as? String { return sub == kAXSecureTextFieldSubrole || sub == "AXSecureTextField" }
        if err == .attributeUnsupported || err == .noValue {
            if role == kAXTextFieldRole { throw Failure("secure_state_unknown", "Text-field secure subrole cannot be established") }
            return false
        }
        throw Failure("secure_state_unknown", "Secure-field status cannot be established")
    }
    func inspect(_ limits: [String: Any], _ b: Budget) throws -> [String: Any] {
        guard Set(limits.keys).isSubset(of: ["maxNodes", "maxDepth", "maxBytes", "timeoutMs"]) else { throw Failure("invalid_request", "Unknown inspect limits") }
        let maxNodes = try integer(limits["maxNodes"] ?? 120, 1, 300), maxDepth = try integer(limits["maxDepth"] ?? 8, 1, 20), maxBytes = try integer(limits["maxBytes"] ?? 65536, 1024, 131072)
        guard let t = selected, let window else { throw Failure("target_not_selected", "Select a target before inspect") }
        _ = try validate(t, b)
        var queue: [(AXUIElement, Int, String?)] = [(window, 0, nil)], rows: [[String: Any]] = [], cursor = 0, bytes = 2, truncated = false
        while cursor < queue.count && rows.count < maxNodes {
            try b.check(); let (e, depth, parent) = queue[cursor]; cursor += 1
            guard try owned(e, b) else { continue }
            let candidate = try id(e), role = try stringAttr(e, kAXRoleAttribute, b) ?? "unknown", security = try? secure(e, b)
            var row: [String: Any] = ["id": candidate, "depth": depth, "role": role, "secure": security ?? true, "securityKnown": security != nil]
            if let parent { row["parentId"] = parent }
            if security == false {
                if let title = try stringAttr(e, kAXTitleAttribute, b) { row["title"] = String(title.prefix(256)) }
                let (descriptionError, description) = try attr(e, kAXDescriptionAttribute, b)
                let (valueError, value) = try attr(e, kAXValueAttribute, b)
                row["semantics"] = ["AXDescription": semanticField(descriptionError, description), "AXValue": semanticField(valueError, value)]
            } else {
                let withheld: [String: Any] = ["read": false, "status": "withheld", "reason": "secure-or-unknown"]
                row["semantics"] = ["AXDescription": withheld, "AXValue": withheld]
            }
            // Pure completion-predicate cases; no Session, app activation or AX messages.
let foregroundTarget = try Target(["bundleId": "fixture.app", "pid": 123, "processBirth": "1234.5", "windowId": 88])
let exactForeground: [String: Any] = ["identityMatches": true, "isActive": true, "frontmostPID": 123, "frontmostBundleId": "fixture.app"]
precondition(activationPostcondition(foregroundTarget, exactForeground, focusedWindowMatches: true))
precondition(!activationPostcondition(foregroundTarget, exactForeground, focusedWindowMatches: false))
for (key, bad) in [("identityMatches", false as Any), ("isActive", false as Any), ("frontmostPID", 999 as Any), ("frontmostBundleId", "other.app" as Any)] {
    var changed = exactForeground; changed[key] = bad
    precondition(!activationPostcondition(foregroundTarget, changed, focusedWindowMatches: true))
}
var missingForeground = exactForeground; missingForeground.removeValue(forKey: "isActive")
precondition(!activationPostcondition(foregroundTarget, missingForeground, focusedWindowMatches: true))
let encoded = try JSONSerialization.data(withJSONObject: row)
            if bytes + encoded.count + 1 > maxBytes - 768 { truncated = true; break }; bytes += encoded.count + 1; rows.append(row)
            if depth < maxDepth {
                let available = maxNodes - queue.count
                if available > 0 {
                    let (children, extra) = try elements(e, kAXChildrenAttribute, limit: available, budget: b)
                    queue.append(contentsOf: children.map { ($0, depth + 1, candidate) }); truncated = truncated || extra
                } else { truncated = true }
            } else { truncated = true }
        }
        truncated = truncated || cursor < queue.count
        let result: [String: Any] = ["status": "inspected", "identity": t.raw, "candidates": rows, "truncated": truncated, "evidence": ["native": true, "nodes": rows.count, "candidateBytes": bytes, "maxNodes": maxNodes, "maxDepth": maxDepth, "maxBytes": maxBytes, "menusIncluded": false] as [String: Any]]
        // Reserve protocol envelope overhead, then verify the actual encoded response budget.
        guard try JSONSerialization.data(withJSONObject: result).count + 128 <= maxBytes else { throw Failure("output_limit", "Inspect result exceeds requested byte budget") }
        return result
    }
    func check(_ t: Target, _ c: [String: Any], _ b: Budget) throws -> [String: Any] {
        try exact(c, ["kind", "locator", "property", "equals"])
        guard c["kind"] as? String == "ax" else { throw Failure("invalid_request", "Only AX conditions") }
        let property = try text(c["property"]), bools = ["exists", "enabled", "focused", "selected"]
        guard bools.contains(property) || ["value", "title"].contains(property) else { throw Failure("invalid_request", "Unsupported AX condition") }
        if bools.contains(property) { guard let n = c["equals"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw Failure("invalid_request", "Boolean equals required") } }
        else { guard let s = c["equals"] as? String, s.count <= 4000 else { throw Failure("invalid_request", "String equals required") } }
        _ = try validate(t, b)
        var observation: Any
        var locatorId = ""
        if property == "exists" {
            let l = try object(c["locator"]); try exact(l, ["id"]); locatorId = try text(l["id"], 128)
            guard let e = candidates[locatorId] else { throw Failure("stale_locator", "Unknown candidate ID") }
            observation = try owned(e, b)
        } else {
            let (id, e) = try resolve(c["locator"], b); locatorId = id
            if try secure(e, b) { throw Failure("secure_field", "Secure field properties are not exposed") }
            let names = ["enabled": kAXEnabledAttribute, "focused": kAXFocusedAttribute, "selected": kAXSelectedAttribute, "value": kAXValueAttribute, "title": kAXTitleAttribute]
            let (err, value) = try attr(e, names[property]!, b)
            guard err == .success, let value else { throw Failure("ax_read_failed", "AX condition unavailable (\(err.rawValue))") }
            if bools.contains(property), let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { observation = n.boolValue }
            else if !bools.contains(property), let s = value as? String, s.count <= 4000 { observation = s }
            else { throw Failure("ax_read_failed", "AX condition has an unsupported type/size") }
        }
        let pass = NSDictionary(dictionary: ["v": observation]).isEqual(to: ["v": c["equals"]!])
        return ["status": pass ? "pass" : "fail", "evidence": ["native": true, "locatorId": locatorId, "property": property, "observed": observation, "equals": c["equals"]!, "windowId": t.windowId]]
    }
    // Explicit host-approved mutation only; never called implicitly from action().
    func activate(_ t: Target, _ b: Budget) throws -> [String: Any] {
        var before: [String: Any] = [:]
        let running: NSRunningApplication, selectedWindow: AXUIElement, selectedApp: AXUIElement
        do {
            guard !activationAttempted else { throw Failure("activation_already_attempted", "A session permits one activation attempt") }
            _ = try validate(t, b)
            guard let current = NSRunningApplication(processIdentifier: t.pid), let window, let app else { throw Failure("target_not_selected", "Selected target is unavailable") }
            running = current; selectedWindow = window; selectedApp = app
            try b.check(); AXUIElementSetMessagingTimeout(selectedWindow, 1.0)
            var names: CFArray?
            let result = AXUIElementCopyActionNames(selectedWindow, &names)
            try b.check()
            guard result == .success, let actions = names as? [String], actions.contains(kAXRaiseAction) else { throw Failure("raise_unsupported", "Selected window does not expose public AXRaise") }
            _ = try validate(t, b); before = foregroundEvidence(t); try b.check()
            guard before["identityMatches"] as? Bool == true else { throw Failure("target_changed", "Selected process/window changed before activation") }
        } catch let failure as Failure {
            throw Failure(failure.code, failure.text, effect: "none", fence: true, evidence: ["native": true, "operation": "activate", "target": t.raw, "attempted": false, "verified": false, "beforeForeground": before])
        }
        activationAttempted = true // Set before dispatch, including rejected/unknown API outcomes.
        let started = ProcessInfo.processInfo.systemUptime * 1000
        var evidence: [String: Any] = ["native": true, "operation": "activate", "target": t.raw, "attempted": true, "verified": false,
          "api": "NSRunningApplication.activate(options:[])", "apiReturned": NSNull(), "raiseAPI": "AXUIElementPerformAction(selectedWindow, AXRaise)",
          "raiseAXError": NSNull(), "beforeForeground": before, "afterForeground": NSNull(), "focusedWindowMatches": false,
          "dispatchAtMonotonicMs": started, "clock": "ProcessInfo.systemUptime*1000", "verificationLimitMs": 1500]
        do {
            let accepted = running.activate(options: [])
            evidence["apiReturned"] = accepted; try b.check()
            guard accepted else { throw Failure("activation_unverified", "Public activation API rejected the request") }
            let raised = AXUIElementPerformAction(selectedWindow, kAXRaiseAction as CFString)
            evidence["raiseAXError"] = raised.rawValue; try b.check()
            // Keep the raw AXRaise result, including errors. Do not retry it: only
            // the bounded read-only exact-window postcondition below decides completion.
            let deadline = min(ProcessInfo.processInfo.systemUptime + 1.5, b.deadline)
            repeat {
                try b.check(); _ = try identity(t)
                var after = foregroundEvidence(t); evidence["afterForeground"] = after
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { break }
                AXUIElementSetMessagingTimeout(selectedApp, Float(min(0.1, remaining)))
                var focused: CFTypeRef?
                let focusedError = AXUIElementCopyAttributeValue(selectedApp, kAXFocusedWindowAttribute as CFString, &focused)
                try b.check(); _ = try identity(t); after = foregroundEvidence(t); evidence["afterForeground"] = after; evidence["focusedWindowAXError"] = focusedError.rawValue
                let matches = focusedError == .success && focused.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, selectedWindow) } == true
                evidence["focusedWindowMatches"] = matches
                if ProcessInfo.processInfo.systemUptime <= deadline && activationPostcondition(t, after, focusedWindowMatches: matches) {
                    activationVerified = true; evidence["verified"] = true; evidence["frontmostPID"] = after["frontmostPID"]; evidence["frontmostBundleId"] = after["frontmostBundleId"]; evidence["isActive"] = after["isActive"]; evidence["responseAtMonotonicMs"] = ProcessInfo.processInfo.systemUptime * 1000
                    return ["status": "activated", "identity": t.raw, "evidence": evidence]
                }
                RunLoop.current.run(until: Date(timeIntervalSinceNow: min(0.01, max(0, deadline - ProcessInfo.processInfo.systemUptime))))
            } while ProcessInfo.processInfo.systemUptime < deadline
            throw Failure("activation_unverified", "Selected application and exact AXFocusedWindow did not verify within the bound")
        } catch {
            evidence["afterForeground"] = foregroundEvidence(t); evidence["responseAtMonotonicMs"] = ProcessInfo.processInfo.systemUptime * 1000
            evidence["error"] = (error as? Failure)?.text ?? String(describing: error)
            throw Failure("activation_unknown", "Activation attempt is unverified; session fenced", effect: "unknown", fence: true, evidence: evidence)
        }
    }
    func action(_ t: Target, _ a: [String: Any], _ b: Budget) throws -> [String: Any] {
        let kind = try text(a["type"])
        if ["press", "click"].contains(kind) { try exact(a, ["type", "locator"]) }
        else if kind == "type" { try exact(a, ["type", "locator", "text"]); _ = try text(a["text"], 4000) }
        else if kind == "scroll" { try exact(a, ["type", "locator", "deltaX", "deltaY"]); throw Failure("unsupported", "AX scroll is not implemented; no coordinate/event fallback") }
        else { throw Failure("unsupported", "Only AXPress or settable nonsecure text AXValue") }
        _ = try validate(t, b); let (id, e) = try resolve(a["locator"], b)
        if try secure(e, b) { throw Failure("secure_field", "Actions on secure text fields are prohibited") }
        let (enabledError, enabled) = try attr(e, kAXEnabledAttribute, b)
        guard enabledError == .success, let value = enabled as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID(), value.boolValue else { throw Failure("not_enabled", "Candidate is not positively enabled") }
        if kind == "type" {
            let role = try stringAttr(e, kAXRoleAttribute, b)
            guard role == kAXTextFieldRole || role == kAXTextAreaRole else { throw Failure("unsupported", "AXValue input requires a text field or text area") }
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { throw Failure("not_settable", "Text AXValue is not settable") }
        } else {
            try b.check(); var names: CFArray?
            guard AXUIElementCopyActionNames(e, &names) == .success, let actions = names as? [String], actions.contains(kAXPressAction) else { throw Failure("unsupported", "Candidate does not expose public AXPress") }
        }
        // Last target + retained-locator checks happen at native dispatch, after all preflight reads.
        _ = try validate(t, b); guard try owned(e, b) else { throw Failure("stale_locator", "Locator changed before dispatch") }; try b.check()
        if activationVerified {
            guard let app, let window else { throw Failure("focus_changed", "Selected foreground window is unavailable", fence: true) }
            let (focusedError, focused) = try attr(app, kAXFocusedWindowAttribute, b)
            let focusMatches = focusedError == .success && focused.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window) } == true
            let observed = foregroundEvidence(t); try b.check()
            guard focusMatches && observed["identityMatches"] as? Bool == true && observed["isActive"] as? Bool == true &&
                observed["frontmostPID"] as? Int == Int(t.pid) && observed["frontmostBundleId"] as? String == t.bundleId else {
                throw Failure("focus_changed", "Previously activated selected window lost foreground/focus; no action dispatched", effect: "none", fence: true,
                  evidence: ["native": true, "operation": "action-foreground-check", "target": t.raw, "attempted": false, "verified": false,
                    "foreground": observed, "focusedWindowMatches": focusMatches, "focusedWindowAXError": focusedError.rawValue])
            }
        }
        let dispatchForeground = foregroundEvidence(t)
        guard dispatchForeground["identityMatches"] as? Bool == true else { throw Failure("target_changed", "Identity changed at dispatch observation", fence: true) }
        if activationVerified && (dispatchForeground["isActive"] as? Bool != true || dispatchForeground["frontmostPID"] as? Int != Int(t.pid) || dispatchForeground["frontmostBundleId"] as? String != t.bundleId) {
            throw Failure("focus_changed", "Activated application lost foreground immediately before dispatch", effect: "none", fence: true, evidence: ["native": true, "target": t.raw, "attempted": false, "foreground": dispatchForeground])
        }
        try b.check()
        let dispatchAt = ProcessInfo.processInfo.systemUptime * 1000
        let result: AXError
        if kind == "type" { result = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, a["text"] as! String as CFString) }
        else { result = AXUIElementPerformAction(e, kAXPressAction as CFString) }
        let responseAt = ProcessInfo.processInfo.systemUptime * 1000
        let evidence: [String: Any] = ["native": true, "operation": kind == "type" ? "AXValue-set" : "AXPress", "locatorId": id,
          "axError": result.rawValue, "outcomeVerified": false, "target": t.raw, "windowId": t.windowId,
          "dispatchAtMonotonicMs": dispatchAt, "responseAtMonotonicMs": responseAt, "dispatchElapsedMs": responseAt-dispatchAt,
          "clock": "ProcessInfo.systemUptime*1000", "dispatchForeground": dispatchForeground, "responseForeground": foregroundEvidence(t)]
        guard result == .success else { throw Failure("dispatch_unknown", "AX dispatch returned \(result.rawValue); effect unknown and session fenced", effect: "unknown", fence: true, evidence: evidence) }
        return ["status": "performed", "evidence": evidence]
    }
    func handle(_ request: [String: Any]) throws -> [String: Any] {
        let op = try text(request["op"], 32)
        let fields: [String: [String]] = ["probe": [], "enumerate": [], "select": ["target"], "validate": ["target"], "inspect": ["limits"], "check": ["target", "condition"], "action": ["target", "action"], "activate": ["target"]]
        guard let extra = fields[op] else { throw Failure("invalid_request", "Unknown operation") }
        try exact(request, ["requestId", "op"] + extra)
        if fenced { throw Failure("session_fenced", "Explicit new session required") }
        if op == "probe" { return ["status": "probed", "accessibilityTrusted": AXIsProcessTrusted(), "permissionPromptRequested": false, "processBirthUnit": "unix-seconds-six-decimals", "supports": ["public-AXPress", "settable-nonsecure-AXValue", "selected-window-inspect", "single-selected-window-activate"], "scrollSupported": false, "evidence": ["native": true, "helperPid": ProcessInfo.processInfo.processIdentifier] as [String: Any]] }
        if op == "enumerate" {
            var rows: [[String: Any]] = []
            for row in cgWindows() where rows.count < 200 {
                guard (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                      let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                      let windowId = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                      let app = NSRunningApplication(processIdentifier: pid), let bundle = app.bundleIdentifier,
                      let birth = processBirth(pid), let frame = cgFrame(row) else { continue }
                rows.append(["target": ["bundleId": bundle, "pid": pid, "processBirth": birthString(birth), "windowId": windowId] as [String: Any], "title": String((row[kCGWindowName as String] as? String ?? "").prefix(256)), "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height]])
            }
            return ["status": "enumerated", "windows": rows, "evidence": ["native": true, "onScreenOnly": true, "maxWindows": 200, "count": rows.count] as [String: Any]]
        }
        let budget: Budget
        if op == "inspect" { let limits = try object(request["limits"]); budget = Budget(Double(try integer(limits["timeoutMs"] ?? 2000, 1, 3000))/1000); return try inspect(limits, budget) }
        budget = Budget()
        let target = try Target(object(request["target"]))
        if op == "select" { return try select(target, budget) }
        if op == "validate" { return try validate(target, budget) }
        if op == "activate" { return try activate(target, budget) }
        if op == "check" { return try check(target, object(request["condition"]), budget) }
        return try action(target, object(request["action"]), budget)
    }
}

#if AX_SEMANTIC_TESTS
// A separate offline-only build tests real Swift serialization, without Session/probe/AX calls.
let stringTest = semanticField(.success, "digit one" as CFString)
precondition(stringTest["type"] as? String == "string" && stringTest["value"] as? String == "digit one" && stringTest["axError"] as? Int32 == 0)
let longTest = semanticField(.success, String(repeating: "😀", count: 400) as CFString)
precondition((longTest["value"] as? String)?.unicodeScalars.count == 256 && longTest["truncated"] as? Bool == true)
let integerTest = semanticField(.success, NSNumber(value: 42))
precondition(integerTest["type"] as? String == "number" && integerTest["value"] as? String == nil && (integerTest["value"] as? NSNumber)?.intValue == 42)
let booleanTest = semanticField(.success, NSNumber(value: true))
precondition(booleanTest["type"] as? String == "boolean" && booleanTest["value"] as? Bool == true)
let unavailableTest = semanticField(.cannotComplete, nil)
precondition(unavailableTest["status"] as? String == "unavailable" && unavailableTest["axError"] as? Int32 == -25204 && unavailableTest["value"] == nil)
let unsupportedTest = semanticField(.attributeUnsupported, nil)
precondition(unsupportedTest["status"] as? String == "unsupported" && unsupportedTest["axError"] as? Int32 == -25205)
let missingTest = semanticField(.success, nil)
precondition(missingTest["status"] as? String == "unavailable" && missingTest["type"] as? String == "missing")
let otherTest = semanticField(.success, ["not stringified"] as CFArray)
precondition(otherTest["status"] as? String == "unsupported_type" && otherTest["value"] == nil)
let nonfiniteTest = semanticField(.success, NSNumber(value: Double.nan))
precondition(nonfiniteTest["status"] as? String == "unsupported_value" && nonfiniteTest["value"] == nil)
let encoded = try JSONSerialization.data(withJSONObject: [stringTest, longTest, integerTest, booleanTest, unavailableTest, unsupportedTest, missingTest, otherTest, nonfiniteTest])
precondition(encoded.count < 8192)
print("{\"kind\":\"pure-semantic-tests\",\"cases\":17,\"passed\":true,\"axQueries\":0}")
#else
let session = Session()
_ = AXIsProcessTrusted() // Startup probes only. Never AXIsProcessTrustedWithOptions/prompt/TCC bypass.
func emit(_ response: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), data.count <= 262143 else {
        let fallback: [String: Any] = ["requestId": response["requestId"] ?? NSNull(), "ok": false, "error": ["code": "output_limit", "message": "Native output limit exceeded", "effect": "none"]]
        if let data = try? JSONSerialization.data(withJSONObject: fallback) { FileHandle.standardOutput.write(data + Data([10])) }; return
    }
    FileHandle.standardOutput.write(data + Data([10]))
}
var input = Data()
var readBuffer = [UInt8](repeating: 0, count: 4096)
while true {
    let count = readBuffer.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
    if count < 0 { if errno == EINTR { continue }; exit(74) }
    if count == 0 { if !input.isEmpty { exit(65) }; break }
    let chunk = Data(readBuffer.prefix(count))
    input.append(chunk)
    while let newline = input.firstIndex(of: 10) {
        let line = input.subdata(in: 0..<newline); input.removeSubrange(0...newline)
        if line.count > 32767 { exit(65) }
        var requestId: Any = NSNull()
        do {
            let request = try object(JSONSerialization.jsonObject(with: line))
            let id = try text(request["requestId"], 128); guard UUID(uuidString: id) != nil else { throw Failure("invalid_request", "UUID requestId required") }; requestId = id
            let result = try session.handle(request); emit(["requestId": id, "ok": true, "result": result])
        } catch let failure as Failure {
            if failure.fence { session.fenced = true }
            var error: [String: Any] = ["code": failure.code, "message": failure.text, "effect": failure.effect]
            if let evidence = failure.evidence { error["evidence"] = evidence }
            emit(["requestId": requestId, "ok": false, "error": error])
        } catch { emit(["requestId": requestId, "ok": false, "error": ["code": "invalid_request", "message": "Invalid JSON or request", "effect": "none"]]) }
    }
    if input.count > 32767 { exit(65) }
}
#endif
