// Short-lived real API fixture shared with renderer tests; never connects to the user's App.
import '../harness/env.ts';
import { startIsolated } from '../harness/service.ts';
import { FakeReviewer } from '../harness/fake-reviewer.ts';
import { NativeDesktopError } from '../../service/codex-desktop-transport.ts';

const transport = new FakeReviewer();
let appConnected = true,
  loaded = true;
const read = transport.readThread.bind(transport);
transport.connect = async () => {
  if (!appConnected) throw new NativeDesktopError('Codex App 已关闭，请重新打开。');
};
transport.status = () => ({ connected: appConnected, socketPath: 'fixture-only', lastError: null });
transport.readThread = async (id) => {
  if (!loaded) throw new NativeDesktopError('请先在 Codex App 中打开此对话，再连接同步。', 'no-client-found');
  return read(id);
};
Object.assign(transport, { threadStatus: () => ({ ready: appConnected && loaded }) });
const s = await startIsolated({ nativeTransport: transport });
try {
  const thread = await transport.createThread(s.path);
  transport.listThreads = async () => [
    {
      id: thread.threadId,
      title: 'fixture',
      cwd: s.path,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      archived: false,
      model: null,
      source: 'fixture',
    },
  ];
  await s.native.bind(s.channel.id, thread.threadId);
  const conversation = () => s.api('GET', `/api/channels/${s.channel.id}/native/conversation`);
  loaded = false;
  const unloaded = await conversation();
  const nativeStatus = await s.api('GET', '/api/native/status');
  appConnected = false;
  const unloadedThenOffline = await conversation();
  appConnected = true;
  loaded = true;
  // A fresh native snapshot is the recovery signal; merely toggling the double is not a sync.
  transport.emit(thread.threadId);
  const restored = await conversation();
  appConnected = false;
  const offline = await conversation();
  console.log(
    JSON.stringify({
      project: s.project,
      channel: s.store.get('channels', s.channel.id),
      unloaded,
      unloadedThenOffline,
      restored,
      offline,
      nativeStatus,
      sentMessages: transport.sent.length,
    })
  );
} finally {
  await s.cleanup();
}
