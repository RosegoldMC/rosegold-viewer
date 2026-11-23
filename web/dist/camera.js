const f = 1 / Math.tan(Math.PI / 6);
const near = 0.05;
const far = 256;
const depth = (far + near) / (far - near);
const bias = -2 * far * near / (far - near);
export function unitLook(look) {
    const length = Math.hypot(...look);
    if (look.length !== 3 || length === 0 || !Number.isFinite(length)) {
        throw new RangeError("Expected a finite, nonzero look vector");
    }
    return [look[0] / length, look[1] / length, look[2] / length];
}
export function cameraMatrix([x, y, z], aspect, yaw) {
    const radians = (yaw % 360) * (Math.PI / 180);
    const rightX = -Math.cos(radians);
    const rightZ = -Math.sin(radians);
    const upX = -rightZ * y;
    const upY = rightZ * x - rightX * z;
    const upZ = rightX * y;
    return new Float32Array([
        rightX * f / aspect, upX * f, x * depth, x,
        0, upY * f, y * depth, y,
        rightZ * f / aspect, upZ * f, z * depth, z,
        0, 0, bias, 0,
    ]);
}
