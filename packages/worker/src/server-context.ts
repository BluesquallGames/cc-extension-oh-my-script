import { type ClientInvocationMethodId, type Ipc, type ServerInvocationMethodId } from "./protocol.js";

export class ServerContext {
  constructor(public readonly ipc: Ipc<ServerInvocationMethodId, ClientInvocationMethodId>) {
  }
}