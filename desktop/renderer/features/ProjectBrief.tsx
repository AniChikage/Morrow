import { useEffect, useState, type FormEvent } from 'react';
import { Pencil } from 'lucide-react';
import type { Project, ProjectBrief as ProjectBriefData } from '../../shared/types';
import type { FeatureProps } from './types';
import { Button, Markdown } from '../components/ui';
import './content.css';

export const briefHeadings = [
  '目标与成功标准',
  '目标用户与场景',
  '当前阶段与已知问题',
  '优先级与不做的事',
  '资源与入口',
  '约束与红线',
  '需要我决定的事',
];
/** Suggested outline for a new brief: one Markdown section per heading, bodies left to the user. */
export const briefTemplate = briefHeadings.map((heading) => `## ${heading}\n`).join('\n');
export const briefPlaceholder = `写下你知道而仓库里没有的东西：${briefHeadings.join('、')}。支持 Markdown。`;
export const briefRule =
  'Codex 每轮都会读取项目说明，把它当作优先于自己推断的要求，但不会修改它；发现冲突或缺口时会在对话里提问。';
// An older service answers the brief routes with this exact message; the tab then stays read-only.
const unsupportedMessage = '接口不存在';

type Draft = { goal: string; brief: string; revision: number };

/** The user's own requirements for a project, rendered as the central document and edited in place. */
export function ProjectBrief({
  api,
  project,
  busy,
  onMutate,
}: Pick<FeatureProps, 'api' | 'busy' | 'onMutate'> & { project: Project }) {
  const [loaded, setLoaded] = useState<ProjectBriefData>();
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [attempt, setAttempt] = useState(0);
  const apply = (result: ProjectBriefData) => {
    setLoaded(result);
    setError('');
    setUnsupported(false);
  };
  const fail = (failure: unknown) => {
    const message = failure instanceof Error ? failure.message : '项目说明加载失败';
    if (message === unsupportedMessage) setUnsupported(true);
    else setError(message);
  };
  // The polled snapshot only carries the revision; the text is fetched here and again whenever that revision moves.
  useEffect(() => {
    if (!api.getProjectBrief) return;
    let cancelled = false;
    api.getProjectBrief(project.id).then(
      (result) => {
        if (!cancelled) apply(result);
      },
      (failure) => {
        if (!cancelled) fail(failure);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, project.id, project.briefRevision, attempt]);
  const supported = !!api.getProjectBrief && !unsupported;
  const canEdit = supported && !!api.updateProject && !project.isDemo;
  const stale = !!draft && !!loaded && draft.revision !== loaded.briefRevision;
  const changed = !!draft && !!loaded && (draft.goal.trim() !== loaded.goal || draft.brief.trim() !== loaded.brief);
  const edit = () => loaded && setDraft({ goal: loaded.goal, brief: loaded.brief, revision: loaded.briefRevision });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !loaded || stale || !api.updateProject) return;
    const patch = { goal: draft.goal.trim(), brief: draft.brief.trim(), revision: draft.revision };
    const ok = await onMutate(async () => {
      try {
        const updated = await api.updateProject!(project.id, patch);
        apply({
          goal: updated.goal,
          brief: updated.brief ?? patch.brief,
          briefRevision: updated.briefRevision ?? draft.revision + 1,
        });
      } catch (failure) {
        // The desktop bridge keeps only the error text, so re-read the brief: a moved revision means
        // someone else saved first, and the draft is then held back until the latest version is loaded.
        try {
          if (api.getProjectBrief) apply(await api.getProjectBrief(project.id));
        } catch {
          /* The original failure is reported below. */
        }
        throw failure;
      }
    });
    if (ok) setDraft(undefined);
  }
  if (!supported)
    return (
      <div className="feature-scroll finding-document-scroll">
        <article className="finding-document brief-document">
          <h1>项目说明</h1>
          <section className="finding-section">
            <h2>项目目标</h2>
            <Markdown>{project.goal}</Markdown>
          </section>
          <p className="subtle">当前连接的 Morrow 服务尚不支持项目说明；更新服务后可以在这里写下你的要求。</p>
        </article>
      </div>
    );
  if (error)
    return (
      <div className="feature-scroll">
        <p role="alert" className="form-error">
          {error}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </button>
        </p>
      </div>
    );
  if (!loaded) return <p className="subtle">正在读取项目说明…</p>;
  const writingHelp = (
    <details className="brief-help" key={draft ? 'editing-help' : 'reading-help'}>
      <summary>编写帮助</summary>
      <p>{briefRule}</p>
      <p>写下你知道而仓库里没有的东西：{briefHeadings.join('、')}。支持 Markdown。</p>
    </details>
  );
  if (draft)
    return (
      <div className="feature-scroll finding-document-scroll">
        <form className="finding-document brief-document" onSubmit={save} aria-label="编辑项目说明">
          <div className="brief-heading">
            <h1>编辑项目说明</h1>
            <div className="brief-actions">
              <Button disabled={busy} onClick={() => setDraft(undefined)}>
                取消
              </Button>
              <Button variant="primary" type="submit" disabled={busy || stale || !changed || !draft.goal.trim()}>
                {busy ? '正在保存…' : '保存'}
              </Button>
            </div>
          </div>
          <p className="subtle brief-intro">保存你的要求，Codex 后续轮次会读取。当前为版本 {draft.revision}。</p>
          {stale && (
            <p role="alert" className="form-error">
              项目说明已在别处更新（版本 {loaded.briefRevision}）。载入最新版本会放弃当前未保存的修改。
              <button type="button" onClick={edit}>
                载入最新版本
              </button>
            </p>
          )}
          <label className="form-field brief-goal-field">
            <span className="field-label">项目目标</span>
            <textarea
              value={draft.goal}
              onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
              maxLength={20000}
              placeholder="一句话说明这个项目要持续达成什么。"
              required
            />
          </label>
          <label className="form-field">
            <span className="field-label">项目说明</span>
            <textarea
              className="brief-input"
              value={draft.brief}
              onChange={(event) => setDraft({ ...draft, brief: event.target.value })}
              maxLength={65536}
              placeholder="写下项目要求，支持 Markdown。"
            />
          </label>
          {writingHelp}
          {!draft.brief.trim() && (
            <Button variant="ghost" disabled={busy} onClick={() => setDraft({ ...draft, brief: briefTemplate })}>
              插入模板
            </Button>
          )}
        </form>
      </div>
    );
  return (
    <div className="feature-scroll finding-document-scroll">
      <article className="finding-document brief-document">
        <div className="brief-heading">
          <h1>项目说明</h1>
          {canEdit && (
            <Button variant="primary" disabled={busy} onClick={edit}>
              <Pencil size={13} />
              编辑
            </Button>
          )}
        </div>
        <p className="subtle brief-intro">
          {canEdit ? '通过「编辑」更新项目要求。' : '项目要求由作者维护。'}
          {loaded.briefRevision > 0 ? ` 当前为版本 ${loaded.briefRevision}。` : ''}
        </p>
        <section className="finding-section">
          <h2>项目目标</h2>
          <Markdown>{loaded.goal}</Markdown>
        </section>
        {loaded.brief ? (
          <section className="finding-section brief-body">
            <Markdown>{loaded.brief}</Markdown>
          </section>
        ) : (
          <section className="finding-section">
            <h2>还没有项目说明</h2>
            <p className="subtle">
              {canEdit ? '点击「编辑」写下项目要求。' : project.isDemo ? '示例项目不能编辑。' : ''}
            </p>
          </section>
        )}
        {writingHelp}
      </article>
    </div>
  );
}
