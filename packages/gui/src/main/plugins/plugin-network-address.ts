import { isIP } from "node:net";
export interface PluginNetworkAddress { readonly address: string; readonly family: 4 | 6 }
/** Conservative public-unicast policy. All IANA special-purpose prefixes are
 * excluded, even their globally reachable special-service exceptions. IPv6
 * translation/tunnel/mapped forms are not accepted as an IPv4 escape hatch.
 * Sources: https://www.iana.org/assignments/iana-ipv4-special-registry/
 *          https://www.iana.org/assignments/iana-ipv6-special-registry/ */
export function isPublicPluginAddress(address: string): boolean {
  if (typeof address !== "string" || address.length > 64 || address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c, d] = address.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 31 && c === 196) || (b === 52 && c === 193)
        || (b === 88 && c === 99) || (b === 175 && c === 48)))
      || (a === 168 && b === 63 && c === 129 && d === 16)) return false; // Cloud platform virtual-service address.
    return true;
  }
  if (family !== 6 || address.includes(".")) return false;
  const halves = address.toLowerCase().split("::"), left = halves[0]!.split(":").filter(Boolean).map(value => Number.parseInt(value, 16));
  const right = halves.length === 2 ? halves[1]!.split(":").filter(Boolean).map(value => Number.parseInt(value, 16)) : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
  const first = words[0]!, second = words[1]!, third = words[2]!;
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8)) && first !== 0x2002
    && !(first === 0x2620 && second === 0x004f && third === 0x8000)
    && !(first === 0x3fff && second < 0x1000);
}
