import { ArrowUpRight, FileText, Hash, History, Link2, Pencil } from 'lucide-react';
import type { FeatureProps } from './types';
import { Button, Dropdown, DropdownItem, EmptyState, Markdown, PropertyPanel, StatusLabel } from '../components/ui';
import { formatDate, kindLabel, statusLabel } from '../components/format';
import { Property } from './ProjectView';
import { ProjectRecords } from './ProjectRecords';
import { FeatureWork } from './ProjectWork';
import { featureNumber, featureProjectId, featureSourceIds, featureSourceLabel } from './featureOwnership';
import './content.css';

const itemStatuses = ['open', 'investigating', 'verified', 'resolved', 'blocked'];
function evidenceMarkdown(value: string) { return value.replace(/(^|\s)(https?:\/\/[^\s<>]+)(?=\s|$)/g, '$1<$2>'); }
export function FindingView(props: FeatureProps & { id: string }) {
  const { id, snapshot, api, busy, onMutate, onNavigate, onEditFeature, showInspector } = props;
  const item = snapshot.items.find(item => item.id === id);
  const channel = snapshot.channels.find(channel => channel.id === item?.channelId);
  const project = item ? snapshot.projects.find(project => project.id === featureProjectId(item, snapshot.channels)) : undefined;
  if (!item) return <EmptyState icon={<FileText />} title="未找到这个功能" description="它可能已被移除，请返回项目查看其他功能。" />;
  const contributors = featureSourceIds(item).filter(id => id !== item.channelId).map(id => snapshot.channels.find(channel => channel.id === id)).filter(Boolean);
  return <div className="feature-layout"><main className="feature-main">
    <div className="feature-toolbar"><span className="detail-id">{featureNumber(item)}</span><span className="detail-kind">{kindLabel(item.kind)}</span>{project?.isDemo && <span className="feature-demo-label">示例数据</span>}<div className="feature-toolbar-spacer" />{channel && <Button variant="ghost" onClick={() => onNavigate({ kind: 'channel', id: channel.id })}><Hash size={14} />{channel.name}<ArrowUpRight size={12} /></Button>}<Button disabled={busy} onClick={() => onEditFeature(item)}><Pencil size={13} />编辑功能</Button></div>
    <div className="feature-scroll finding-document-scroll"><article className="finding-document"><h1>{item.title}</h1>
      <section className="finding-section"><h2>功能说明</h2><Markdown>{item.summary || '尚未填写功能说明。'}</Markdown></section>
      <section className="finding-section"><h2><Link2 size={17} />证据 <span>{item.evidence.length}</span></h2>{item.evidence.length ? <ol className="evidence-list">{item.evidence.map((evidence, index) => <li key={`${index}-${evidence.slice(0, 24)}`}><div className="evidence-index">{String(index + 1).padStart(2, '0')}</div><div className="evidence-body"><Markdown>{evidenceMarkdown(evidence)}</Markdown></div></li>)}</ol> : <p className="subtle">尚未附带证据，需要继续验证。</p>}</section>
      <section className="finding-section"><h2>下一步</h2><Markdown>{item.nextStep || '尚未记录下一步行动。'}</Markdown></section>
      {project && <FeatureWork api={api} projectId={project.id} itemId={item.id} />}
      {project && <section className="finding-section feature-history-section"><h2><History size={16} />变更记录</h2><ProjectRecords {...props} projectId={project.id} itemId={item.id} /></section>}
    </article></div>
  </main>{showInspector && <PropertyPanel><section className="property-section"><h3>属性</h3><Property label="状态"><Dropdown trigger={<button type="button" className="property-status-button" disabled={busy}><StatusLabel status={item.status} /></button>}>{itemStatuses.map(status => <DropdownItem key={status} disabled={busy} selected={item.status === status} onSelect={() => void onMutate(() => api.patchItem(item.id, { status, ...(item.revision !== undefined ? { revision: item.revision } : {}) }))}>{statusLabel(status)}</DropdownItem>)}</Dropdown></Property><Property label="类型">{kindLabel(item.kind)}</Property><Property label="首次来源">{channel ? <button className="property-link" onClick={() => onNavigate({ kind: 'channel', id: channel.id })}># {channel.name}</button> : featureSourceLabel(item, snapshot.channels)}</Property>{contributors.length > 0 && <Property label="参与频道">{contributors.map(channel => channel && <button key={channel.id} className="property-link feature-contributor-link" onClick={() => onNavigate({ kind: 'channel', id: channel.id })}># {channel.name}</button>)}</Property>}</section><section className="property-section"><h3>记录</h3><Property label="创建时间">{formatDate(item.createdAt)}</Property><Property label="更新时间">{formatDate(item.updatedAt)}</Property><Property label="证据">{item.evidence.length} 条</Property>{item.revision !== undefined && <Property label="版本">{item.revision}</Property>}</section>{project && <section className="property-section"><h3>所属项目</h3><Button variant="ghost" onClick={() => onNavigate({ kind: 'project', id: project.id })}><FileText size={14} />{project.name}<ArrowUpRight size={12} /></Button></section>}</PropertyPanel>}</div>;
}
