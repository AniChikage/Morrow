// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeConversation, NativeItem } from '../../shared/types';
import { NativeConversationView } from './NativeConversationView';
import { ChannelView } from './ChannelView';
import { featureProps, nativeStatus, snapshot, TestProviders, timestamp } from './testFixtures';
import { nativeImageSource } from './NativeImages';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function message(id: string, text = `消息 ${id}`, role: NativeItem['role'] = 'assistant'): NativeItem {
  return { id, turnId: `turn-${id}`, type: role === 'user' ? 'userMessage' : 'agentMessage', role, text, createdAt: timestamp, raw: { id, text } };
}
function conversation(patch: Partial<NativeConversation> = {}): NativeConversation {
  return { channelId: 'channel-system', threadId: 'native-thread', thread: { id: 'native-thread', title: '已存在的 App 对话', cwd: '/tmp/atlas', status: 'idle', model: 'native-model' }, status: { ...nativeStatus, available: true, connected: true, detail: '连接到原生 App', capabilities: { list: true, read: true, send: true, create: false, interrupt: true, respond: true } }, items: [message('one', 'App 中已有的回复')], requests: [], hasMore: false, lastSyncedAt: timestamp, ...patch };
}
function setup(initial = conversation()) {
  const { props, api } = featureProps();
  vi.mocked(props.api.getNativeConversation).mockResolvedValue(initial);
  return { props, api };
}

describe('native App conversation', () => {
  it('creates and chats through the background without opening the App task', async () => {
    const base=conversation();const unbound=conversation({threadId:undefined,thread:undefined,items:[],status:{...base.status,backgroundReady:true,capabilities:{...base.status.capabilities,create:true}}});
    const {props,api}=setup(unbound);api.createNativeThread.mockResolvedValue(conversation({status:unbound.status}));
    vi.mocked(props.api.getNativeConversation).mockResolvedValueOnce(unbound).mockResolvedValue(conversation({status:unbound.status}));
    render(<NativeConversationView channelId="channel-system" api={props.api}/>,{wrapper:TestProviders});
    await userEvent.setup().click(await screen.findByRole('button',{name:'新建原生对话'}));
    const input=await screen.findByRole('textbox',{name:'发送到 Codex App 原生对话'});fireEvent.change(input,{target:{value:'直接在 NoHuman 继续'}});fireEvent.keyDown(input,{key:'Enter',metaKey:true});
    await waitFor(()=>expect(api.sendNativeMessage).toHaveBeenCalled());expect(api.openNativeApp).not.toHaveBeenCalled();expect(api.sendMessage).not.toHaveBeenCalled();
  });
  it('offers one-time background setup and keeps the current task in place',async()=>{
    const initial=conversation();const {props,api}=setup(initial);const configure=vi.fn().mockResolvedValue({restartRequired:true,detail:'configured'});props.api.setupNativeBackground=configure;
    render(<NativeConversationView channelId="channel-system" api={props.api}/>,{wrapper:TestProviders});
    await userEvent.setup().click(await screen.findByRole('button',{name:'启用后台连接'}));await waitFor(()=>expect(configure).toHaveBeenCalledTimes(1));expect(api.openNativeApp).not.toHaveBeenCalled();expect(api.createNativeThread).not.toHaveBeenCalled();
  });
  const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';

  it('loads native image content by bound item and actual block index and supports a zoom preview', async () => {
    const user = userEvent.setup();
    const withImage = message('image-item', '检查这个截图', 'user');
    withImage.raw = { content: [{ type: 'text', text: '检查这个截图' }, { type: 'localImage', path: '/private/native-only.png', name: '产品截图' }] };
    const { props, api } = setup(conversation({ items: [withImage] }));
    api.getNativeImage.mockResolvedValue({ dataUrl: imageData });
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    const image = await screen.findByRole('img', { name: '产品截图' });
    expect(image.getAttribute('src')).toBe(imageData);
    expect(api.getNativeImage).toHaveBeenCalledWith('channel-system', 'image-item', 1);
    await user.click(screen.getByRole('button', { name: '放大产品截图' }));
    expect(screen.getByRole('dialog', { name: '产品截图' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '关闭图片预览' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders App steering input as a human message with its image and a discrete native steer marker', async () => {
    const steering: NativeItem = { id: 'steer-message', turnId: 'active-turn', type: 'steeringUserMessage', text: '运行中从 App 追加的指令', role: 'user', raw: { input: [{ type: 'text', text: '运行中从 App 追加的指令' }, { type: 'localImage', path: '/native/steering.png', name: '追加图片' }] } };
    const marker: NativeItem = { id: 'steer-marker', turnId: 'active-turn', type: 'steered', text: '', raw: { type: 'steered', id: 'steer-marker' } };
    const { props, api } = setup(conversation({ items: [steering, marker], thread: { ...conversation().thread!, status: 'active', activeTurnId: 'active-turn' } }));
    api.getNativeImage.mockResolvedValue({ dataUrl: imageData });
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    expect(await screen.findByText('运行中从 App 追加的指令')).toBeTruthy();
    expect(screen.getByRole('article').classList.contains('human-event')).toBe(true);
    expect(await screen.findByRole('img', { name: '追加图片' })).toBeTruthy();
    expect(api.getNativeImage).toHaveBeenCalledWith('channel-system', 'steer-message', 1);
    expect(screen.getByText('指令已追加到当前轮次')).toBeTruthy();
    expect(screen.queryByText('steered')).toBeNull();
    expect(screen.queryByText('原生消息内容')).toBeNull();
  });

  it('rejects untrusted image URLs and permits retry after a scoped native image read fails', async () => {
    expect(nativeImageSource('https://untrusted.example/image.png')).toBeUndefined();
    expect(nativeImageSource('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined();
    expect(nativeImageSource('file:///private/picture.png')).toBeUndefined();
    const withImage = message('image-item', '', 'user');
    withImage.raw = { content: [{ type: 'image', url: 'https://native.example/private-image.png' }] };
    const { props, api } = setup(conversation({ items: [withImage] }));
    api.getNativeImage.mockRejectedValueOnce(new Error('原生图片暂不可读取')).mockResolvedValueOnce({ dataUrl: imageData });
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('原生图片暂不可读取');
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '重新加载原生图片' }));
    expect((await screen.findByRole('img', { name: '原生图片' })).getAttribute('src')).toBe(imageData);
    expect(api.getNativeImage).toHaveBeenCalledTimes(2);
  });

  it('sends image-only messages with opaque attachment IDs, strips previews, and clears accepted attachments', async () => {
    const user = userEvent.setup();
    const { props, api } = setup();
    vi.mocked(props.api.chooseNativeImages).mockResolvedValue([{ id: 'image-upload-1', name: '界面.png', mimeType: 'image/png', previewUrl: imageData }]);
    api.sendNativeMessage.mockResolvedValue({ state: 'accepted', requestId: 'image-request', turnId: 'image-turn' });
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('已同步');
    await user.click(screen.getByRole('button', { name: '添加图片' }));
    expect(api.chooseNativeImages).toHaveBeenCalledWith('channel-system');
    expect(await screen.findByRole('img', { name: '界面.png' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '发送到 Codex App' }));
    expect(api.sendNativeMessage).toHaveBeenCalledWith('channel-system', { text: '', requestId: expect.any(String), attachments: [{ id: 'image-upload-1', name: '界面.png', mimeType: 'image/png' }] });
    await waitFor(() => expect(screen.queryByRole('button', { name: '移除图片 界面.png' })).toBeNull());
    expect((screen.getByRole('button', { name: '发送到 Codex App' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps uncertain image sends intact and reconciles the same attachment IDs and request ID', async () => {
    const user = userEvent.setup();
    const { props, api } = setup();
    vi.mocked(props.api.chooseNativeImages).mockResolvedValue([{ id: 'uncertain-image', name: '保留.jpg', mimeType: 'image/jpeg' }]);
    api.sendNativeMessage.mockResolvedValueOnce({ state: 'unknown', requestId: 'same' }).mockResolvedValueOnce({ state: 'accepted', requestId: 'same' });
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('已同步');
    await user.click(screen.getByRole('button', { name: '添加图片' }));
    await screen.findByRole('button', { name: '移除图片 保留.jpg' });
    await user.click(screen.getByRole('button', { name: '发送到 Codex App' }));
    await screen.findByText('消息的接收状态尚未确认');
    expect((screen.getByRole('button', { name: '移除图片 保留.jpg' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '核对发送结果' }));
    await waitFor(() => expect(api.sendNativeMessage).toHaveBeenCalledTimes(2));
    expect(api.sendNativeMessage.mock.calls[1]).toEqual(api.sendNativeMessage.mock.calls[0]);
    expect(api.sendNativeMessage.mock.calls[1][1].attachments?.[0].id).toBe('uncertain-image');
    await waitFor(() => expect(screen.queryByText('保留.jpg')).toBeNull());
  });

  it('limits a draft to five images and lets the user remove a selected image without sending', async () => {
    const user = userEvent.setup();
    const { props, api } = setup();
    const images = Array.from({ length: 5 }, (_, index) => ({ id: `image-${index}`, name: `截图${index}.png`, mimeType: 'image/png' }));
    vi.mocked(props.api.chooseNativeImages).mockResolvedValue(images);
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('已同步');
    await user.click(screen.getByRole('button', { name: '添加图片' }));
    await screen.findByRole('button', { name: '移除图片 截图4.png' });
    expect((screen.getByRole('button', { name: '添加图片' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '移除图片 截图2.png' }));
    expect(screen.queryByRole('button', { name: '移除图片 截图2.png' })).toBeNull();
    expect((screen.getByRole('button', { name: '添加图片' }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.sendNativeMessage).not.toHaveBeenCalled();
  });

  it('renders canonical messages and complete tool output and sends exact text directly to the native thread', async () => {
    const toolOutput = '工具输出\n'.repeat(1000) + '未截断的末尾';
    const initial = conversation({ items: [message('human', '从 App 发送的输入', 'user'), message('agent'), { id: 'cmd', turnId: 'turn-agent', type: 'commandExecution', role: 'tool', text: '', input: 'printf hello', output: toolOutput, status: 'completed', raw: { command: 'printf hello', aggregatedOutput: toolOutput } }] });
    const { props, api } = setup(initial);
    api.sendNativeMessage.mockResolvedValue({ requestId: 'received', state: 'accepted', turnId: 'new-turn' });
    render(<NativeConversationView channelId="channel-system" api={props.api} active={false} />, { wrapper: TestProviders });
    expect(await screen.findByText('从 App 发送的输入')).toBeTruthy();
    expect(screen.getByText('已同步')).toBeTruthy();
    expect(screen.getByText('运行命令')).toBeTruthy();
    expect(screen.queryByText(/未截断的末尾/)).toBeNull();
    await userEvent.setup().click(screen.getByText('运行命令'));
    await screen.findByText(/未截断的末尾/);
    expect(screen.getAllByText(/未截断的末尾/).length).toBeGreaterThan(0);
    const editor = screen.getByRole('textbox', { name: '发送到 Codex App 原生对话', hidden: true });
    fireEvent.change(editor, { target: { value: '  原样保留\n最后一行  ' } });
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendNativeMessage).toHaveBeenCalledWith('channel-system', { text: '  原样保留\n最后一行  ', requestId: expect.any(String) }));
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(''));
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.channelAction).not.toHaveBeenCalled();
  });

  it('keeps large tool Markdown, output and raw serialization out of the DOM until each details level is opened', async () => {
    const user = userEvent.setup();
    const output = '长工具输出\n'.repeat(30_000) + '完整输出结束标记';
    let rawReads = 0;
    const raw = { command: 'read-large-file', get detailedPayload() { rawReads++; return '完整原生记录独有内容'; } };
    const tool: NativeItem = { id: 'large-tool', turnId: 'turn-large', type: 'commandExecution', text: '**工具说明未渲染**', input: 'read-large-file', output, status: 'completed', raw };
    const { props } = setup(conversation({ items: [tool] }));
    const view = render(<NativeConversationView channelId="channel-system" api={props.api} active={false} />, { wrapper: TestProviders });
    await screen.findByText('运行命令');
    expect(view.container.querySelector('pre')).toBeNull();
    expect(screen.queryByText('工具说明未渲染')).toBeNull();
    expect(rawReads).toBe(0);
    await user.click(screen.getByText('运行命令'));
    await screen.findByText('工具说明未渲染');
    expect(screen.getByText(/完整输出结束标记/).textContent).toBe(output);
    expect(screen.queryByText(/完整原生记录独有内容/)).toBeNull();
    expect(rawReads).toBe(0);
    await user.click(screen.getByText('完整原生记录'));
    await screen.findByText(/完整原生记录独有内容/);
    expect(rawReads).toBeGreaterThan(0);
    await user.click(screen.getByText('运行命令'));
    await waitFor(() => expect(view.container.querySelector('pre')).toBeNull());
    expect(screen.queryByText('工具说明未渲染')).toBeNull();
  });

  it('automatically opens a tool when it fails, respects a later manual collapse, and labels subagent activity', async () => {
    const user = userEvent.setup();
    const tool: NativeItem = { id: 'failing-tool', turnId: 'turn-tool', type: 'commandExecution', text: '', output: '原生失败详情', status: 'inProgress', raw: {} };
    const subagent: NativeItem = { id: 'child-task', turnId: 'turn-tool', type: 'subAgentActivity', text: '子任务记录', raw: {} };
    const { props } = setup(conversation({ items: [tool, subagent] }));
    render(<NativeConversationView channelId="channel-system" api={props.api} active={false} />, { wrapper: TestProviders });
    await screen.findByText('子任务活动');
    expect(screen.queryByText('原生失败详情')).toBeNull();
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation({ items: [{ ...tool, status: 'failed' }, subagent] }));
    await user.click(screen.getByRole('button', { name: '重新连接并同步对话', hidden: true }));
    await screen.findByText('原生失败详情');
    await user.click(screen.getByText('运行命令'));
    await waitFor(() => expect(screen.queryByText('原生失败详情')).toBeNull());
    await user.click(screen.getByRole('button', { name: '重新连接并同步对话', hidden: true }));
    expect(screen.queryByText('原生失败详情')).toBeNull();
  });

  it('polls App changes, replaces streaming text by native ID, and never duplicates messages', async () => {
    const { props } = setup();
    const view = render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('App 中已有的回复');
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation({ items: [message('one', '原生实时完整回复'), message('two', 'App 新增输入', 'user')] }));
    fireEvent.focus(window);
    await screen.findByText('原生实时完整回复');
    expect(screen.queryByText('App 中已有的回复')).toBeNull();
    fireEvent.focus(window);
    await waitFor(() => expect(props.api.getNativeConversation).toHaveBeenCalledTimes(3));
    expect(screen.getAllByText('App 新增输入')).toHaveLength(1);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    view.unmount();
  });

  it('keeps history and draft on disconnect, blocks sending, then resumes from canonical App history', async () => {
    const { props, api } = setup();
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('App 中已有的回复');
    const editor = screen.getByRole('textbox', { name: '发送到 Codex App 原生对话' });
    fireEvent.change(editor, { target: { value: '断线仍保留的输入' } });
    vi.mocked(props.api.getNativeConversation).mockRejectedValueOnce(new Error('App 连接断开'));
    fireEvent.focus(window);
    await screen.findByText('连接已断开');
    expect(screen.getByText('App 中已有的回复')).toBeTruthy();
    expect(screen.queryByText('已同步')).toBeNull();
    expect((screen.getByRole('button', { name: '发送到 Codex App' }) as HTMLButtonElement).disabled).toBe(true);
    expect((editor as HTMLTextAreaElement).value).toBe('断线仍保留的输入');
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation({ items: [message('one'), message('external', '断线期间在 App 发出的消息', 'user')] }));
    fireEvent.focus(window);
    await screen.findByText('断线期间在 App 发出的消息');
    expect(screen.getByText('已同步')).toBeTruthy();
    expect(api.sendNativeMessage).not.toHaveBeenCalled();
  });

  it('retains an ambiguous send and reconciles using the same idempotency key without issuing a second message', async () => {
    const user = userEvent.setup();
    const { props, api } = setup();
    api.sendNativeMessage.mockRejectedValueOnce(new Error('响应丢失')).mockResolvedValueOnce({ state: 'accepted', requestId: 'same', turnId: 'accepted-turn' });
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('已同步');
    const editor = screen.getByRole('textbox', { name: '发送到 Codex App 原生对话' });
    await user.type(editor, '只发送这条一次');
    await user.click(screen.getByRole('button', { name: '发送到 Codex App' }));
    await screen.findByText('消息的接收状态尚未确认');
    expect((editor as HTMLTextAreaElement).value).toBe('只发送这条一次');
    expect((screen.getByRole('button', { name: '发送到 Codex App' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '核对发送结果' }));
    await waitFor(() => expect(api.sendNativeMessage).toHaveBeenCalledTimes(2));
    expect(api.sendNativeMessage.mock.calls[1]).toEqual(api.sendNativeMessage.mock.calls[0]);
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe(''));
    expect(screen.queryByText('消息的接收状态尚未确认')).toBeNull();
  });

  it('shows real connection state until a thread snapshot has synced and keeps the App new-task entry available', async () => {
    const user = userEvent.setup();
    const { props, api } = setup(conversation({ threadId: undefined, thread: undefined, items: [], lastSyncedAt: undefined }));
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('尚未关联对话');
    expect(screen.queryByText('已同步')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '发送到 Codex App 原生对话' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建原生对话' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '在 Codex App 中新建会话' }));
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
    expect(api.createNativeThread).not.toHaveBeenCalled();
  });

  it('binds a selected project thread and rejects a stale pre-binding response', async () => {
    const user = userEvent.setup();
    const { props, api } = setup(conversation({ threadId: undefined, thread: undefined, items: [], lastSyncedAt: undefined }));
    vi.mocked(props.api.listNativeThreads).mockResolvedValue({ status: conversation().status, threads: [conversation().thread!] });
    api.bindNativeThread.mockResolvedValue(conversation());
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await user.click(await screen.findByRole('button', { name: '关联 App 对话' }));
    let resolveStale!: (value: NativeConversation) => void;
    vi.mocked(props.api.getNativeConversation).mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }));
    fireEvent.focus(window);
    await user.click(await screen.findByRole('button', { name: /已存在的 App 对话/ }));
    await screen.findByText('App 中已有的回复');
    await act(async () => resolveStale(conversation({ threadId: undefined, thread: undefined, items: [], lastSyncedAt: undefined })));
    expect(screen.getByText('App 中已有的回复')).toBeTruthy();
    expect(api.bindNativeThread).toHaveBeenCalledWith('channel-system', 'native-thread');
  });

  it('loads older native items without duplication and retains the loaded range on live updates', async () => {
    const initial = conversation({ items: [message('three'), message('four')], hasMore: true, cursor: 'three' });
    const { props } = setup(initial);
    vi.mocked(props.api.getNativeConversation).mockImplementation(async (_id, query) => query?.before ? conversation({ items: [message('one'), message('two'), message('three')], hasMore: false }) : initial);
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await userEvent.setup().click(await screen.findByRole('button', { name: '加载更早对话' }));
    await screen.findByText('消息 one');
    fireEvent.focus(window);
    await waitFor(() => expect(props.api.getNativeConversation).toHaveBeenCalledTimes(3));
    expect(screen.getAllByRole('article').map(article => article.textContent?.match(/消息 \w+/)?.[0])).toEqual(['消息 one', '消息 two', '消息 three', '消息 four']);
    expect(screen.queryByRole('button', { name: '加载更早对话' })).toBeNull();
  });

  it('fills a multi-page reconnect gap before merging the existing visible history', async () => {
    const { props } = setup(conversation({ items: [message('one'), message('two')] }));
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await screen.findByText('消息 one');
    vi.mocked(props.api.getNativeConversation).mockImplementation(async (_id, query) => query?.before ? conversation({ items: [message('two'), message('three')], hasMore: true, cursor: 'two' }) : conversation({ items: [message('four'), message('five')], hasMore: true, cursor: 'four' }));
    fireEvent.focus(window);
    await screen.findByText('消息 five');
    expect(props.api.getNativeConversation).toHaveBeenCalledWith('channel-system', { limit: 80, before: 'four' });
    expect(screen.getAllByRole('article').map(article => article.textContent?.match(/消息 \w+/)?.[0])).toEqual(['消息 one', '消息 two', '消息 three', '消息 four', '消息 five']);
    expect(screen.queryByRole('button', { name: '加载更早对话' })).toBeNull();
  });

  it('ignores late history from a previous channel and targets interrupt at the current exact turn', async () => {
    const { props, api } = setup();
    let resolveOld!: (value: NativeConversation) => void;
    vi.mocked(props.api.getNativeConversation).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const view = render(<NativeConversationView channelId="old-channel" api={props.api} />, { wrapper: TestProviders });
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation({ channelId: 'new-channel', thread: { ...conversation().thread!, status: 'active', activeTurnId: 'actual-turn' } }));
    view.rerender(<NativeConversationView channelId="new-channel" api={props.api} />);
    await screen.findByText('App 中已有的回复');
    await act(async () => resolveOld(conversation({ channelId: 'old-channel', items: [message('old', '旧频道迟到记录')] })));
    expect(screen.queryByText('旧频道迟到记录')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: '停止当前原生轮次' }));
    expect(api.interruptNativeTurn).toHaveBeenCalledWith('new-channel', 'actual-turn');
  });

  it('submits native approvals and structured user answers and waits for canonical request removal', async () => {
    const requests: NativeConversation['requests'] = [
      { id: 'approval', type: 'item/commandExecution/requestApproval', status: 'pending', raw: { method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } } },
      { id: 'question', type: 'item/tool/requestUserInput', status: 'pending', raw: { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', header: '颜色', question: '选择颜色', options: [{ label: '灰白', description: '保留现有风格' }], isOther: true }] } } },
    ];
    const { props, api } = setup(conversation({ requests }));
    api.respondNativeRequest.mockResolvedValue({ ok: true });
    render(<NativeConversationView channelId="channel-system" api={props.api} />, { wrapper: TestProviders });
    await userEvent.setup().click(await screen.findByRole('button', { name: '批准本次' }));
    expect(api.respondNativeRequest).toHaveBeenCalledWith('channel-system', 'approval', { decision: 'accept' });
    expect(await screen.findByText('已提交，等待 App 更新请求状态…')).toBeTruthy();
    expect((screen.getByRole('button', { name: '批准本次' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: '选择颜色' }), '灰白');
    await userEvent.setup().click(screen.getByRole('button', { name: '提交回答' }));
    expect(api.respondNativeRequest).toHaveBeenCalledWith('channel-system', 'question', { answers: { choice: { answers: ['灰白'] } } });
  });

  it('centers a channel on direction and guidance, prepares a task on start, and keeps machinery in details',async()=>{
    const user=userEvent.setup(),state=snapshot();state.projects[0].isDemo=false;
    const {props,api}=featureProps({snapshot:state});
    const unbound=conversation({threadId:undefined,thread:undefined,items:[],status:{...conversation().status,backgroundReady:true,capabilities:{...conversation().status.capabilities,create:true}}});
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(unbound);api.createNativeThread.mockResolvedValue(conversation());
    render(<ChannelView {...props} id="channel-system"/>,{wrapper:TestProviders});
    expect(screen.getByText(state.channels[0].goal)).toBeTruthy();expect(screen.queryByRole('tab')).toBeNull();expect(screen.queryByText('每日上限')).toBeNull();expect(screen.queryByRole('button',{name:'运行一次'})).toBeNull();
    await screen.findByText('让 Codex 沿着这个方向开始');await user.click(screen.getByRole('button',{name:'开始工作'}));
    expect(api.createNativeThread).toHaveBeenCalledOnce();expect(api.channelAction).toHaveBeenCalledWith('channel-system','resume');expect(api.openNativeApp).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:'工作详情'}));expect(screen.getByRole('tab',{name:'运行记录 0'})).toBeTruthy();
  });
  it('groups tool activity behind one disclosure while keeping Codex progress visible',async()=>{
    const tool=(id:string)=>({...message(id,'tool output','tool'),type:'commandExecution',status:'completed'});
    const {props}=setup(conversation({items:[message('progress','正在验证用户首次进入的流程。'),tool('one'),tool('two')]}));
    render(<NativeConversationView channelId="channel-system" api={props.api} autonomous compact/>,{wrapper:TestProviders});
    await screen.findByText('正在验证用户首次进入的流程。');expect(screen.queryByText('运行命令')).toBeNull();
    await userEvent.setup().click(screen.getByText('工作过程'));expect(screen.getAllByText('运行命令')).toHaveLength(2);
  });
  it('keeps confirmed work context and next-step protocol out of the normal conversation prose',async()=>{
    const schedule={...message('scheduled','full context from project','user'),autonomousContext:true};
    const reply=message('reply','已验证登录错误提示。\n```nohuman-next\n{"state":"continue"}\n```');
    const {props}=setup(conversation({items:[schedule,reply]}));
    render(<NativeConversationView channelId="channel-system" api={props.api} autonomous compact/>,{wrapper:TestProviders});
    await screen.findByText('已验证登录错误提示。');expect(screen.queryByText('full context from project')).toBeNull();expect(screen.queryByText('{"state":"continue"}')).toBeNull();
    await userEvent.setup().click(screen.getByText('继续工作 · 已准备项目上下文'));expect(screen.getByText('full context from project')).toBeTruthy();
  });
  it('shares the native composer across conversation and activity tabs and never submits bound chat as a legacy note', async () => {
    const user = userEvent.setup();
    const state = snapshot(); state.projects[0].isDemo = false;
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation({ channelId: 'channel-system', lastSyncedAt: undefined }));
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    expect(screen.queryByRole('button',{name:'运行一次'})).toBeNull();
    await user.click(screen.getByRole('button',{name:'工作详情'}));
    expect(screen.getByRole('tab', { name: '原生对话' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('button', { name: '开始工作' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('textbox', { name: '向频道补充上下文' })).toBeNull();
    await screen.findByText('正在同步');
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation());
    api.sendNativeMessage.mockResolvedValue({ state: 'accepted', requestId: 'native-receipt' });
    fireEvent.focus(window);
    await waitFor(() => expect((screen.getByRole('button', { name: '开始工作' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByRole('textbox', { name: '发送到 Codex App 原生对话' }), { target: { value: '  动态页的指令\n保留原文  ' } });
    await user.click(screen.getByRole('tab', { name: '动态' }));
    expect(screen.queryByRole('textbox', { name: '向频道补充上下文' })).toBeNull();
    const editor = screen.getByRole('textbox', { name: '发送到 Codex App 原生对话' });
    expect((editor as HTMLTextAreaElement).value).toBe('  动态页的指令\n保留原文  ');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.sendNativeMessage).toHaveBeenCalledWith('channel-system', { text: '  动态页的指令\n保留原文  ', requestId: expect.any(String) }));
    await waitFor(() => expect(screen.getByRole('tab', { name: '原生对话' }).getAttribute('aria-selected')).toBe('true'));
    expect((screen.getByRole('textbox', { name: '发送到 Codex App 原生对话' }) as HTMLTextAreaElement).value).toBe('');
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '在原生 CLI 中继续' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '在 Codex App 中继续' }));
    expect(api.openNativeApp).toHaveBeenCalledWith('channel-system');
  });

  it('retains an uncertain native activity send across tabs and reconciles its original request without a second legacy submission', async () => {
    const user = userEvent.setup();
    const state = snapshot(); state.projects[0].isDemo = false;
    const { props, api } = featureProps({ snapshot: state });
    vi.mocked(props.api.getNativeConversation).mockResolvedValue(conversation());
    api.sendNativeMessage.mockResolvedValueOnce({ state: 'unknown', requestId: 'pending' }).mockResolvedValueOnce({ state: 'accepted', requestId: 'confirmed' });
    render(<ChannelView {...props} id="channel-system" />, { wrapper: TestProviders });
    await user.click(screen.getByRole('button',{name:'工作详情'}));
    await screen.findByText('已同步');
    await user.click(screen.getByRole('tab', { name: '动态' }));
    fireEvent.change(screen.getByRole('textbox', { name: '发送到 Codex App 原生对话' }), { target: { value: '只发送一次' } });
    await user.click(screen.getByRole('button', { name: '发送到 Codex App' }));
    await screen.findByText('消息的接收状态尚未确认');
    await user.click(screen.getByRole('tab', { name: '原生对话' }));
    await user.click(screen.getByRole('tab', { name: '动态' }));
    expect((screen.getByRole('textbox', { name: '发送到 Codex App 原生对话' }) as HTMLTextAreaElement).value).toBe('只发送一次');
    await user.click(screen.getByRole('button', { name: '核对发送结果' }));
    await waitFor(() => expect(api.sendNativeMessage).toHaveBeenCalledTimes(2));
    expect(api.sendNativeMessage.mock.calls[1]).toEqual(api.sendNativeMessage.mock.calls[0]);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
