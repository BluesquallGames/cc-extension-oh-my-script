import { expect, it } from 'vitest';
import { extractInlineUUID, writeInlineUUID } from '../src/uuid-manager.js';
import { describe } from 'node:test';

const uuid = `5ebe6607-c90f-49dd-8162-b3096e4b72b2`;
const uuid2 = `cfd747d9-9b9d-4960-9499-c5de60e8bd64`;
const uuid3 = `56b55876-83c6-4435-aec6-d0e5398b7514`;

it('extract and update', () => {
  const code = [
    '  ',
    '',
    ` console.log('dummy')`,
    '',
    `   /// <meta   "uuid"   =   "${uuid}"   / > `,
    `/// <meta "uuid"="${uuid2}" />`,
    '  ',
    '',
  ].join('\n');

  expect(extractInlineUUID(code)).toBe(uuid);

  const newCode = writeInlineUUID(code, uuid3);
  expect(newCode).toMatchSnapshot();
  expect(extractInlineUUID(newCode)).toBe(uuid3);
});

void describe('write', () => {
  it('new', () => {
    expect(writeInlineUUID('', uuid)).toMatchSnapshot();
    expect(writeInlineUUID('console;\n', uuid)).toMatchSnapshot();
  });

  const line = `/// <meta "uuid"="${uuid}" />`;

  it('update', () => {
    expect(writeInlineUUID(`${line}\n`, uuid)).toMatchSnapshot();
    expect(writeInlineUUID(`console;\n${line}`, uuid)).toMatchSnapshot();
    expect(writeInlineUUID(`console;\n${line}\nconsole;`, uuid)).toMatchSnapshot();
  });
});
