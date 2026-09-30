import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OriginTracker } from "./originTracker";

describe("OriginTracker", () => {
  it("isRemote is true only while markRemote runs", async () => {
    const o = new OriginTracker();
    assert.equal(o.isRemote(), false);
    let saw = false;
    await o.markRemote(async () => {
      assert.equal(o.isRemote(), true);
      saw = true;
    });
    assert.equal(saw, true);
    assert.equal(o.isRemote(), false);
  });

  it("nests depth so overlapping remotes stay marked", async () => {
    const o = new OriginTracker();
    await o.markRemote(async () => {
      assert.equal(o.isRemote(), true);
      await o.markRemote(async () => {
        assert.equal(o.isRemote(), true);
      });
      assert.equal(o.isRemote(), true);
    });
    assert.equal(o.isRemote(), false);
  });
});
