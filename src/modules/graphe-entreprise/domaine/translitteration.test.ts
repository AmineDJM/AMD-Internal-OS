import { describe, expect, it } from "vitest";
import { contientArabe, squelette, translitterer } from "./translitteration";
import { motsCompares } from "./resolution";

const sq = (t: string) => motsCompares(t).map(squelette).sort().join(" ");

describe("translittération arabe → latin et squelette consonantique", () => {
  it("reconnaît l'arabe, y compris les formes de présentation", () => {
    expect(contientArabe("محمد")).toBe(true);
    expect(contientArabe("Mohamed")).toBe(false);
    expect(translitterer("ﻣﺤﻤﺪ")).toBe("mohamed");
  });

  it.each([
    ["محمد بن علي", "Mohamed Benali"],
    ["محمد بن علي", "Mohammed Ben Ali"],
    ["عبد القادر", "Abdelkader"],
    ["عبد القادر", "Abd El Kader"],
    ["عبد الرحمن", "Abderrahmane"],
    ["وهيبة", "Ouahiba"],
    ["وهيبة", "Wahiba"],
    ["يوسف", "Youcef"],
    ["فاطمة الزهراء", "Fatima Ez-Zohra"],
    ["صيدال", "Saidal"],
    ["حسين شريف", "Hocine Cherif"],
    ["مصطفى باشا", "Mustapha Pacha"],
    ["جمال خالدي", "Djamel Khaldi"],
  ])("« %s » et « %s » ont le même squelette", (ar, lat) => {
    expect(sq(ar)).toBe(sq(lat));
  });

  it("le squelette rapproche sans tout confondre", () => {
    expect(squelette("mohamed")).toBe("mhmd");
    expect(squelette("abdelkader")).toBe("bdlkdr");
    expect(squelette("benali")).not.toBe(squelette("brahimi"));
  });
});
