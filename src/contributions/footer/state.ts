export type RightPanelState = {
  state: BuildStateType.never;
} | {
  state: BuildStateType.building;
} | {
  state: BuildStateType.completed;
  startTime: number;
};

export enum BuildStateType {
  never = 'never',
  building = 'building',
  completed = 'completed',
}
