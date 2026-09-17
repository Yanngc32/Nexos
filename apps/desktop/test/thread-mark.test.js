// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { marcarLinhaAtiva } from "../thread-mark.js";

describe("marcarLinhaAtiva", () => {
  it("só troca data-on, não recria nós", () => {
    document.body.innerHTML =
      '<ul id="t"><li data-thread-id="a" data-on="1"></li><li data-thread-id="b" data-on="0"></li></ul>';
    const ul = document.getElementById("t");
    const a = ul.children[0];
    expect(marcarLinhaAtiva(ul, "b")).toBe(2);
    expect(a.dataset.on).toBe("0");
    expect(ul.children[1].dataset.on).toBe("1");
    expect(ul.children[0]).toBe(a);
  });

  it("sem raiz, zero", () => {
    expect(marcarLinhaAtiva(null, "x")).toBe(0);
  });
});
