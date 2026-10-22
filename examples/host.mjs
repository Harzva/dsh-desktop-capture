// Runs inside a DSH DEVICE HOST that already owns its observation service and
// real attachment store. Importing this example never captures anything.
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
export async function connectDesktopCapture(ctx, { observe, attachments }) {
  if (typeof observe !== 'function' || typeof attachments?.saveImage !== 'function') throw new TypeError('A device observation function and real DSH attachment store are required');
  const service = await ctx.plugin(host => {
    host.provide('desktopCapture', {
      observe: (args, execution) => observe(args, execution),
      saveImage: (input, execution) => {
        if (execution.signal.aborted) throw execution.signal.reason || Error('Aborted');
        return attachments.saveImage(input);
      }
    });
  });
  const entry = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')).href;
  const id = await ctx.loader.create({ name: entry });
  await ctx.loader.await();
  return async () => { ctx.loader.remove(id); await ctx.loader.await(); await service.dispose(); };
}
