import { describe, expect, it } from 'vitest';
import extensionPackage from '../package.json';

describe('Oh My Script project settings contribution', () => {
  it('exposes the Electron RunAsNode policy as a default-enabled project checkbox', () => {
    /// @case
    /// 1. Cocos Creator or Vortex loads the extension manifest.
    /// @expect
    /// Project Settings exposes a default-enabled boolean RunAsNode option under the Oh My Script
    /// tab.
    expect(extensionPackage).toMatchObject({
      contributions: {
        profile: {
          project: {
            'builder.useElectronRunAsNode': {
              type: 'boolean',
              default: true,
            },
          },
        },
        project: {
          ohMyScript: {
            label: 'Oh My Script',
            content: {
              'builder.useElectronRunAsNode': {
                ui: 'ui-checkbox',
              },
            },
          },
        },
      },
    });
  });
});
