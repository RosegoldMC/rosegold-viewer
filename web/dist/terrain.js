export const SECTION_SIZE = 16;
export const SECTION_VOLUME = SECTION_SIZE ** 3;
export const VERTEX_STRIDE = 6;
const SECTION_MASK = SECTION_SIZE - 1;
const faces = [
    { step: [1, 0, 0], corners: [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1] },
    { step: [-1, 0, 0], corners: [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0] },
    { step: [0, 1, 0], corners: [0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0] },
    { step: [0, -1, 0], corners: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1] },
    { step: [0, 0, 1], corners: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1] },
    { step: [0, 0, -1], corners: [0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0] },
];
const triangles = [0, 3, 6, 0, 6, 9];
const palette = [
    [154, 161, 192], [111, 187, 139], [111, 121, 155], [215, 149, 105],
    [97, 191, 199], [238, 203, 134], [187, 143, 191], [202, 103, 114],
];
function stateColor(state) {
    if (state < palette.length)
        return palette[state];
    const hash = Math.imul(state, 0x9e3779b1);
    return [96 + (hash & 127), 96 + ((hash >>> 8) & 127), 96 + ((hash >>> 16) & 127)];
}
function offset(position, [dx, dy, dz]) {
    return [position[0] + dx, position[1] + dy, position[2] + dz];
}
export function sectionKey(position) {
    return position.join(",");
}
export function cellIndex(x, y, z) {
    return x + SECTION_SIZE * (z + SECTION_SIZE * y);
}
export class Terrain {
    sections = new Map();
    dirty = new Map();
    air = new Set();
    constructor(airStateIds) {
        for (const id of airStateIds) {
            if (!Number.isInteger(id) || id < 0 || id > 65535)
                throw new RangeError("Invalid air state ID");
            this.air.add(id);
        }
    }
    replaceSection(position, states) {
        if (position.length !== 3 || position.some(value => !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
            throw new RangeError("Expected signed 32-bit section coordinates");
        }
        if (states !== null && states.length !== SECTION_VOLUME) {
            throw new RangeError(`Expected ${SECTION_VOLUME} section states`);
        }
        const key = sectionKey(position);
        const previous = this.sections.get(key);
        if (previous && states?.every((state, i) => state === previous.states[i]))
            return false;
        const populated = states !== null && !states.every(id => this.air.has(id));
        if (!populated && !previous)
            return false;
        if (populated) {
            const storedPosition = previous?.position ?? [...position];
            this.sections.set(key, { position: storedPosition, states: states.slice() });
            this.dirty.set(key, storedPosition);
        }
        else {
            this.sections.delete(key);
            this.dirty.delete(key);
        }
        for (const face of faces) {
            const neighborKey = sectionKey(offset(position, face.step));
            const neighbor = this.sections.get(neighborKey);
            if (neighbor)
                this.dirty.set(neighborKey, neighbor.position);
        }
        return true;
    }
    clear() {
        this.sections.clear();
        this.dirty.clear();
    }
    markAllDirty() {
        for (const [key, { position }] of this.sections)
            this.dirty.set(key, position);
    }
    takeDirty() {
        const positions = [...this.dirty.values()];
        this.dirty.clear();
        return positions;
    }
    hasSection(key) {
        return this.sections.has(key);
    }
    mesh(position) {
        const section = this.sections.get(sectionKey(position));
        if (!section)
            return null;
        const { states } = section;
        const neighbors = faces.map(face => this.sections.get(sectionKey(offset(position, face.step)))?.states);
        let vertices = new Uint8Array(1024);
        let length = 0;
        for (let y = 0; y < SECTION_SIZE; y++) {
            for (let z = 0; z < SECTION_SIZE; z++) {
                for (let x = 0; x < SECTION_SIZE; x++) {
                    const state = states[cellIndex(x, y, z)];
                    if (this.air.has(state))
                        continue;
                    let color;
                    for (let f = 0; f < faces.length; f++) {
                        const { step: [dx, dy, dz], corners } = faces[f];
                        const nx = x + dx, ny = y + dy, nz = z + dz;
                        const outside = nx < 0 || ny < 0 || nz < 0 || nx === SECTION_SIZE || ny === SECTION_SIZE || nz === SECTION_SIZE;
                        const adjacent = outside
                            ? neighbors[f]?.[cellIndex(nx & SECTION_MASK, ny & SECTION_MASK, nz & SECTION_MASK)]
                            : states[cellIndex(nx, ny, nz)];
                        if (adjacent !== undefined && !this.air.has(adjacent))
                            continue;
                        if (length + triangles.length * VERTEX_STRIDE > vertices.length) {
                            const larger = new Uint8Array(vertices.length * 2);
                            larger.set(vertices);
                            vertices = larger;
                        }
                        color ??= stateColor(state);
                        for (const i of triangles) {
                            vertices[length++] = x + corners[i];
                            vertices[length++] = y + corners[i + 1];
                            vertices[length++] = z + corners[i + 2];
                            vertices[length++] = color[0];
                            vertices[length++] = color[1];
                            vertices[length++] = color[2];
                        }
                    }
                }
            }
        }
        return length ? vertices.subarray(0, length) : null;
    }
}
