export interface Contributions {
  'asset-db'?: {
    'script'?: string;

    'asset-handler'?: Array<{
      handler: string;
      name: string;
      extnames: string[];
    }>;

    'mount'?: {
      path: string;
      readonly?: boolean;
    };
  };

  'builder'?: string;

  'inspector'?: {
    section?: {
      asset?: Record<string, string>;
      node?: Record<string, string>;
    };
  };

  'menu'?: Array<{
    path?: string;
    label?: string;
    message?: string;
    group?: string;
    order?: number;
  }>;

  'messages'?: Record<string, {
    methods: string[];
  }>;

  'scene'?: {
    script: string;
  };

  'server'?: string;
}
