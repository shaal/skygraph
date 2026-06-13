// The switchable all-sky dome projections (docs/project.js radialFrac/
// setProjection). Pure radial-law math; the on-screen dome is the browser's job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { radialFrac, setProjection, projectionMode } from "../project.js";

const MODES = ["fisheye", "stereographic", "orthographic", "equalArea"];

test("every projection puts the horizon on the rim and the zenith at the centre", () => {
  for (const m of MODES) {
    setProjection(m);
    assert.ok(Math.abs(radialFrac(0) - 1) < 1e-9, `${m}: horizon → rim`);
    assert.ok(Math.abs(radialFrac(90)) < 1e-9, `${m}: zenith → centre`);
  }
  setProjection("fisheye");
});

test("radius decreases monotonically as elevation rises (zenith pulls inward)", () => {
  for (const m of MODES) {
    setProjection(m);
    let prev = Infinity;
    for (let el = 0; el <= 90; el += 5) {
      const f = radialFrac(el);
      assert.ok(f <= prev + 1e-12, `${m}: not monotonic at el=${el}`);
      prev = f;
    }
  }
  setProjection("fisheye");
});

test("fisheye is the equidistant law (linear in zenith angle)", () => {
  setProjection("fisheye");
  assert.ok(Math.abs(radialFrac(30) - 2 / 3) < 1e-9);
  assert.ok(Math.abs(radialFrac(60) - 1 / 3) < 1e-9);
});

test("projections differ: orthographic pushes mid-elevations outward vs fisheye", () => {
  setProjection("fisheye"); const f = radialFrac(60);
  setProjection("orthographic"); const o = radialFrac(60); // sin30 = 0.5 > 1/3
  assert.ok(o > f, "orthographic radius at el=60 should exceed fisheye");
  setProjection("fisheye");
});

test("setProjection ignores unknown modes and keeps a valid law", () => {
  setProjection("nonsense");
  assert.equal(projectionMode(), "fisheye");
  assert.ok(Math.abs(radialFrac(0) - 1) < 1e-9);
});

test("below-horizon radius stays finite and bounded for all projections", () => {
  for (const m of MODES) {
    setProjection(m);
    assert.ok(Number.isFinite(radialFrac(-45)) && radialFrac(-45) <= 1.8, `${m}: el=-45 bounded`);
    assert.ok(Number.isFinite(radialFrac(-89)) && radialFrac(-89) <= 1.8, `${m}: el=-89 bounded`);
  }
  setProjection("fisheye");
});
