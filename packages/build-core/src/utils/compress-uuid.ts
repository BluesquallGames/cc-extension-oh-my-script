const Base64KeyChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const Reg_Dash = /-/g;
const Reg_Uuid = /^[0-9a-fA-F-]{36}$/;
const Reg_NormalizedUuid = /^[0-9a-fA-F]{32}$/;
const _Reg_CompressedUuid = /^[0-9a-zA-Z+/]{22,23}$/;
const _Reg_CompressedSubAssetUuid = /^([0-9a-zA-Z+/]{22,23})((@[0-9a-fA-F]{5,})+)+$/;
const Reg_subAssetUuid = /([^@]{32,36})((@[0-9a-fA-F]{5,})+)+$/;
const _Reg_UuidInLibPath = /.*[/\\][0-9a-fA-F]{2}[/\\]([0-9a-fA-F-]{8,}((@[0-9a-fA-F]{5,})+)?).*/;

export function compressUuid(uuid: string, min: boolean) {
  const result = Reg_subAssetUuid.exec(uuid);
  if (!result) {
    return compressNormalUuid(uuid, min);
  }
  uuid = result[1];
  return compressNormalUuid(uuid, min) + result[2];
}

function compressNormalUuid(uuid: string, min: boolean) {
  if (Reg_Uuid.test(uuid)) {
    uuid = uuid.replace(Reg_Dash, '');
  } else if (!Reg_NormalizedUuid.test(uuid)) {
    return uuid;
  }
  const reserved = (min === true) ? 2 : 5;
  return compressHex(uuid, reserved);
}

function compressHex(hexString: string, reservedHeadLength: number) {
  const length = hexString.length;
  let i;
  if (reservedHeadLength !== undefined) {
    i = reservedHeadLength;
  } else {
    i = length % 3;
  }
  const head = hexString.slice(0, i);
  const base64Chars = [];
  while (i < length) {
    const hexVal1 = parseInt(hexString[i], 16);
    const hexVal2 = parseInt(hexString[i + 1], 16);
    const hexVal3 = parseInt(hexString[i + 2], 16);
    base64Chars.push(Base64KeyChars[(hexVal1 << 2) | (hexVal2 >> 2)]);
    base64Chars.push(Base64KeyChars[((hexVal2 & 3) << 4) | hexVal3]);
    i += 3;
  }
  return head + base64Chars.join('');
}
