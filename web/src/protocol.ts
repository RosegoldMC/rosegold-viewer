export const minecraftVersions = { 775: "26.1", 777: "26.3" } as const;
export type Protocol = keyof typeof minecraftVersions;

export function isProtocol(value: unknown): value is Protocol {
  return typeof value === "number" && Object.hasOwn(minecraftVersions, value);
}

export function packMismatchLabel(protocol: Protocol, packProtocol: number): string {
  const bot = minecraftVersions[protocol];
  const pack = isProtocol(packProtocol) ? minecraftVersions[packProtocol] : `protocol ${packProtocol}`;
  return `Texture pack is for ${pack}, bot is on ${bot}. Build a pack from the ${bot} client JAR.`;
}
