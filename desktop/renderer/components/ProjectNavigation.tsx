import { useEffect, useState } from 'react';
import { AlertCircle, Columns3, Folder, Hash, Plus } from 'lucide-react';
import type { Channel, Project, Route } from '../../shared/types';
import './project-navigation.css';

interface Props {
  projects: Project[];
  channels: Channel[];
  route?: Route;
  activeProjectId?: string;
  scope: string;
  onNavigate: (route: Route, newTab?: boolean) => void;
  onNewChannel: (projectId: string) => void;
}

export function ProjectNavigation({ projects, channels, route, activeProjectId, scope, onNavigate, onNewChannel }: Props) {
  const storageKey = `morrow:project-navigation:${scope}`;
  const legacyStorageKey = `nh:project-navigation:${scope}`;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey) ?? '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved)
        ? Object.fromEntries(Object.entries(saved).filter(([, value]) => value === true)) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(collapsed)); } catch { /* Navigation still works when view preferences cannot be saved. */ }
  }, [collapsed, storageKey]);

  const routeKey = route ? `${route.kind}:${'id' in route ? route.id : ''}` : '';
  useEffect(() => {
    if (activeProjectId) setCollapsed(previous => previous[activeProjectId] ? { ...previous, [activeProjectId]: false } : previous);
  }, [activeProjectId, routeKey]);

  const byProject = new Map<string, Channel[]>();
  for (const channel of channels) {
    const group = byProject.get(channel.projectId);
    if (group) group.push(channel); else byProject.set(channel.projectId, [channel]);
  }

  return <div className="project-navigation">{projects.map(project => {
    const children = byProject.get(project.id) || [];
    const expanded = !collapsed[project.id];
    const groupId = `project-content-${project.id}`;
    return <section className="nav-project" aria-label={`${project.name} 项目`} key={project.id}>
      <div className={`nav-project-row ${activeProjectId === project.id ? 'current-project' : ''}`}>
        <button className="project-destination" aria-label={project.name} title={`${expanded ? '收起' : '展开'}项目`} aria-expanded={expanded} aria-controls={groupId} onClick={() => setCollapsed(previous => ({ ...previous, [project.id]: expanded }))}><Folder size={15} /><span>{project.name}</span>{project.isDemo && <span className="nav-demo">示例</span>}{!expanded && children.length > 0 && <span className="project-channel-count">{children.length}</span>}</button>
        <button className="project-add-channel" aria-label={`在 ${project.name} 新建频道`} title="新建频道" onClick={() => { setCollapsed(previous => ({ ...previous, [project.id]: false })); onNewChannel(project.id); }}><Plus size={13} /></button>
      </div>
      <div id={groupId} className="nav-project-content" hidden={!expanded}>
        <button className={`nav-item nav-board ${route?.kind === 'project' && activeProjectId === project.id ? 'selected' : ''}`} aria-label={`${project.name} 的看板`} aria-current={route?.kind === 'project' && activeProjectId === project.id ? 'page' : undefined} onClick={() => onNavigate({ kind: 'project', id: project.id }, true)}><Columns3 size={14} /><span>看板</span></button>
        <div className="nav-project-channels" role="group" aria-label={`${project.name} 的频道`}>
        <div className="nav-channel-heading">频道</div>
        {children.map(channel => <button className={`nav-item nav-channel ${route?.kind === 'channel' && channel.id === route.id ? 'selected' : ''}`} key={channel.id} title={channel.name} aria-current={route?.kind === 'channel' && channel.id === route.id ? 'page' : undefined} onClick={() => onNavigate({ kind: 'channel', id: channel.id })}><Hash size={14} /><span>{channel.name}</span>{channel.status === 'running' && <span className="running-dot" role="img" aria-label="正在运行" />}{channel.status === 'blocked' && <AlertCircle className="nav-trailing warning" aria-label="需要处理" />}</button>)}
        {!children.length && <button className="nav-item nav-channel nav-channel-empty" onClick={() => onNewChannel(project.id)}><Plus size={14} /><span>新建频道</span></button>}
        </div>
      </div>
    </section>;
  })}</div>;
}
