export function addEditorBroadcastListener<TArgs extends unknown[]>(
  eventName: string,
  listener: (...args: TArgs) => void,
) {
  Editor.Message.__protected__.addBroadcastListener(eventName, listener);
}
