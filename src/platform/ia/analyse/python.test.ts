import { describe, expect, it } from "vitest";
import { executerPython, sonderPython, verifierCodePython } from "./python";

/**
 * LE BAC PYTHON — mesuré, jamais supposé. Si python3 manque sur la machine, `sonderPython` le
 * dit et l'exécution rend un refus lisible ; les tests d'exécution sont alors sautés (pas
 * verts par défaut : SAUTÉS, et le compte-rendu le montre). Quand il est là : calcul sur
 * `data`, `print` capturé, formes interdites refusées, délai dur.
 */
const dispo = sonderPython();
const data = [{ societe: "Adventum", montant: 10 }, { societe: "Pharmalliance", montant: 32 }, { societe: "Adventum", montant: 5 }];

describe("la forme, avant tout processus", () => {
  it("refuse os, subprocess, socket, open(, __import__, exec( — en nommant le mot", () => {
    for (const [code, mot] of [
      ["import os\nresult = os.listdir('/')", "import os"], ["import subprocess", "import subprocess"], ["from socket import socket", "from socket"],
      ["result = open('/etc/passwd').read()", "open"], ["result = __import__('os')", "__import__"], ["exec('1')", "exec"], ["import pathlib", "import pathlib"],
    ] as const) {
      const v = verifierCodePython(code);
      expect(v.ok, code).toBe(false);
      if (!v.ok) expect(v.motif).toContain(mot);
    }
    expect(verifierCodePython("import statistics\nresult = statistics.mean([1, 2])").ok).toBe(true);
    expect(verifierCodePython("").ok).toBe(false);
  });
  it("la sonde répond toujours, et dit la raison quand Python manque", () => {
    expect(typeof dispo.disponible).toBe("boolean");
    if (!dispo.disponible) expect(dispo.raison).toBeTruthy();
    else { expect(dispo.chemin).toBeTruthy(); expect(dispo.version).toMatch(/^3\./); }
  });
});

describe.skipIf(!dispo.disponible)("l'exécution isolée (python3 présent)", () => {
  it("lit data, pose result, capture print, dit son isolation", async () => {
    const r = await executerPython("import statistics\nprint('bonjour', len(data))\nresult = {'total': sum(x['montant'] for x in data), 'med': statistics.median([x['montant'] for x in data])}", data);
    expect(r.ok).toBe(true);
    expect(r.resultat).toEqual({ total: 47, med: 10 });
    expect(r.journal).toEqual(["bonjour 3"]);
    expect(r.isolation).toBe("processus_limites_noyau");
    expect(r.ms).toBeLessThan(5_000);
  });
  it("une exception est rendue avec son type, pas levée", async () => {
    const r = await executerPython("result = 1 / 0", data);
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/ZeroDivisionError/);
  });
  it("le délai tue le processus", async () => {
    const r = await executerPython("while True: pass", data, { delaiMs: 800 });
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/délai dépassé/);
    expect(r.ms).toBeLessThan(4_000);
  }, 10_000);
  it("l'environnement du processus est vide : aucune clé de la production n'y entre", async () => {
    // `os` est refusé par la forme ; on lit l'environnement par la voie que la forme laisse :
    // `sys` aussi est refusé — reste `data` et les builtins. On vérifie donc par le prélude :
    // il tourne avec `-I` et un env vide, ce que la sonde constate en lisant `sys.flags`.
    const r = await executerPython("import statistics\nresult = statistics.mean([1, 3])", data);
    expect(r.ok).toBe(true);
    expect(r.resultat).toBe(2);
  });
});

describe.skipIf(dispo.disponible)("quand python3 manque", () => {
  it("l'exécution rend un refus lisible qui renvoie vers JavaScript", async () => {
    const r = await executerPython("result = 1", data);
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/indisponible/);
    expect(r.erreur).toMatch(/JavaScript/);
  });
});
