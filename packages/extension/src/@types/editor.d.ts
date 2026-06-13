declare namespace Editor {
  namespace Message {
    namespace __protected__ {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function addBroadcastListener(id: string, callback: (...args: any[]) => void): void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function removeBroadcastListener(id: string, callback: (...args: any[]) => void): void;
    }
  }

  namespace Package {
    namespace __protected__ {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function on(id: string, callback: (...args: any[]) => void): void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function off(id: string, callback: (...args: any[]) => void): void;
    }
  }
}

declare module 'cc/editor/populate-internal-constants' {
  const constants: Record<string, unknown>;
  export default constants;
}
