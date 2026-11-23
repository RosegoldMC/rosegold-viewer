import { TerrainRenderer, type RendererStatus } from "./renderer.js";
import { SECTION_SIZE, SECTION_VOLUME, cellIndex } from "./terrain.js";

const canvas = document.querySelector("canvas")!;
const status = document.querySelector("output")!;
const labels: Record<RendererStatus, string> = {
  ready: "Fixture ready",
  lost: "WebGL2 context lost; waiting for recovery",
  unavailable: "WebGL2 unavailable",
};

function fixtureState(x: number, y: number, z: number): number {
  const canyon = Math.abs(x + Math.floor(z / 4) - 4);
  const ridge = Math.floor(Math.min(27, canyon) / 3);
  const steps = Math.floor((z + 16) / 8);
  const top = -4 + ridge + steps;
  const archDistance = Math.abs(x + 2);
  if (z >= 18 && z <= 20 && archDistance <= 8 && y <= 10) {
    if (archDistance >= 6 || y >= 8) return y >= 8 ? 5 : 3;
  }
  if (x >= -14 && x <= -10 && z >= 29 && z <= 33 && y <= 15) {
    return y >= 14 ? 7 : 6;
  }
  if (x >= 16 && x <= 19 && z >= 8 && z <= 11 && y === top + 1) return 5;
  if (y > top) return 0;
  if (canyon <= 2 && y === top) return 4;
  if (y === top) return ridge >= 6 ? 3 : 1;
  return y >= top - 2 ? 3 : 2;
}

const renderer = new TerrainRenderer(canvas, {
  airStateIds: [0],
  onStatus(next) {
    status.value = labels[next];
    status.dataset.state = next;
  },
});

for (let sy = -1; sy <= 0; sy++) {
  for (let sz = -1; sz <= 2; sz++) {
    for (let sx = -2; sx <= 1; sx++) {
      const states = new Uint16Array(SECTION_VOLUME);
      for (let y = 0; y < SECTION_SIZE; y++) {
        for (let z = 0; z < SECTION_SIZE; z++) {
          for (let x = 0; x < SECTION_SIZE; x++) {
            states[cellIndex(x, y, z)] = fixtureState(x + sx * SECTION_SIZE, y + sy * SECTION_SIZE, z + sz * SECTION_SIZE);
          }
        }
      }
      renderer.replaceSection([sx, sy, sz], states);
    }
  }
}
renderer.setPaths([{
  name: "canyon",
  color: 0x54F4FF,
  points: [[10.5, 6, 4.5], [7.5, 5, 8.5], [5.5, 5, 13.5], [3.5, 4, 17.5],
    [2.5, 4.5, 23.5], [0.5, 5.5, 29.5], [-4.5, 6.5, 35.5], [-8.5, 6.5, 40.5]],
}]);
renderer.setPose([12.5, 17.5, -4.5], [-0.34, -0.35, 1], Math.atan2(0.34, 1) * 180 / Math.PI);
