export function addEditorBroadcastListener(eventName: string, listener: (...args: any[]) => void) {
  Editor.Message.__protected__.addBroadcastListener(eventName, listener);
}
