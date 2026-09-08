import type { Snapshot, DesktopAPI, Route, Channel, WorkItem } from '../../shared/types';
export interface FeatureProps {
  snapshot: Snapshot;
  api: DesktopAPI;
  busy: boolean;
  onNavigate: (route: Route, newTab?: boolean) => void;
  onMutate: (action: () => Promise<unknown>) => Promise<boolean>;
  onEditChannel: (channel: Channel) => void;
  onNewChannel: (projectId: string) => void;
  onNewFeature: (projectId: string) => void;
  onEditFeature: (item: WorkItem) => void;
  showInspector: boolean;
}
