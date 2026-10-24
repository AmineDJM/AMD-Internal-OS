import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  onlyofficeConfigured, onlyofficeDocType, onlyofficeEditable, fileExt,
  signJwt, verifyJwt, makeFileReadToken, readFileReadToken, makeDocReadToken, readDocReadToken,
  makeSaveToken, readSaveToken, lireRappelOnlyoffice,
} from "./onlyoffice";

const PREV = { url: process.env.ONLYOFFICE_URL, secret: process.env.ONLYOFFICE_JWT_SECRET };

beforeAll(() => {
  process.env.ONLYOFFICE_URL = "https://office.example.com";
  process.env.ONLYOFFICE_JWT_SECRET = "test-secret-123";
});
afterAll(() => {
  process.env.ONLYOFFICE_URL = PREV.url;
  process.env.ONLYOFFICE_JWT_SECRET = PREV.secret;
});

describe("OnlyOffice — configuration & types de documents", () => {
  it("est configuré quand l'URL et le secret sont définis", () => {
    expect(onlyofficeConfigured()).toBe(true);
  });
  it("détecte le type d'éditeur selon l'extension", () => {
    expect(onlyofficeDocType("Rapport.docx")).toBe("word");
    expect(onlyofficeDocType("Budget.XLSX")).toBe("cell");
    expect(onlyofficeDocType("Deck.pptx")).toBe("slide");
    expect(onlyofficeDocType("scan.pdf")).toBeNull();
    expect(onlyofficeEditable("note.txt")).toBe(true);
    expect(onlyofficeEditable("image.png")).toBe(false);
    expect(fileExt("a.b.docx")).toBe("docx");
  });
});

describe("OnlyOffice — JWT HS256", () => {
  it("signe et vérifie un payload (aller-retour)", () => {
    const t = signJwt({ a: 1, b: "x" });
    const p = verifyJwt<{ a: number; b: string }>(t);
    expect(p?.a).toBe(1);
    expect(p?.b).toBe("x");
  });
  it("rejette un jeton falsifié", () => {
    const t = signJwt({ a: 1 });
    const tampered = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    expect(verifyJwt(tampered)).toBeNull();
  });
  it("rejette un jeton expiré", () => {
    const t = signJwt({ a: 1 }, -10); // déjà expiré
    expect(verifyJwt(t)).toBeNull();
  });
  it("rejette un jeton signé avec un autre secret", () => {
    const t = signJwt({ a: 1 });
    process.env.ONLYOFFICE_JWT_SECRET = "autre-secret";
    expect(verifyJwt(t)).toBeNull();
    process.env.ONLYOFFICE_JWT_SECRET = "test-secret-123";
  });
  it("jeton de lecture Drive : aller-retour + rejet d'un jeton de mauvais type", () => {
    const p = readFileReadToken(makeFileReadToken("node-1", "user-9"));
    expect(p).toEqual({ nodeId: "node-1", userId: "user-9", kind: "lecture" });
    expect(readFileReadToken(signJwt({ nodeId: "x", userId: "y" }))).toBeNull();
  });
  it("jeton de lecture de document : aller-retour + isolation des types de jetons", () => {
    const p = readDocReadToken(makeDocReadToken("doc-7", "user-3"));
    expect(p).toEqual({ docId: "doc-7", userId: "user-3", kind: "doclecture" });
    expect(readDocReadToken(makeFileReadToken("node-1", "user-9"))).toBeNull();
    expect(readFileReadToken(makeDocReadToken("doc-7", "user-3"))).toBeNull();
  });
  it("LIRE n'est pas ENREGISTRER : un jeton de lecture n'ouvre pas le rappel, ni l'inverse", () => {
    expect(readSaveToken(makeFileReadToken("node-1", "user-9"))).toBeNull();
    expect(readSaveToken(makeDocReadToken("doc-7", "user-3"))).toBeNull();
    expect(readFileReadToken(makeSaveToken("drive", "node-1", "user-9"))).toBeNull();
    expect(readDocReadToken(makeSaveToken("document", "doc-7", "user-3"))).toBeNull();
    expect(readSaveToken(makeSaveToken("drive", "node-1", "user-9"))).toEqual({ cible: "drive", id: "node-1", userId: "user-9", kind: "enregistrement" });
  });
  it("transition : les jetons uniques d'avant la séparation restent lus par les deux routes (24 h au plus)", () => {
    const ancienDrive = signJwt({ nodeId: "node-1", userId: "user-9", kind: "edit" });
    const ancienDoc = signJwt({ docId: "doc-7", userId: "user-3", kind: "docedit" });
    expect(readFileReadToken(ancienDrive)?.nodeId).toBe("node-1");
    expect(readDocReadToken(ancienDoc)?.docId).toBe("doc-7");
    expect(readSaveToken(ancienDrive)).toEqual({ cible: "drive", id: "node-1", userId: "user-9", kind: "enregistrement" });
    expect(readSaveToken(ancienDoc)).toEqual({ cible: "document", id: "doc-7", userId: "user-3", kind: "enregistrement" });
  });
});

describe("OnlyOffice — le rappel d'enregistrement n'est cru que signé, chez le Document Server", () => {
  const jeton = () => makeSaveToken("drive", "node-1", "user-9");
  const signe = (charge: Record<string, unknown>) => signJwt(charge);
  const base = { id: "node-1", docId: null, autorisation: null };

  it("enregistre un rappel signé (dans le corps) dont l'adresse est chez le Document Server", () => {
    const url = "https://office.example.com/cache/files/node-1_7/output.docx";
    const r = lireRappelOnlyoffice({ ...base, jeton: jeton(), corps: { token: signe({ status: 2, url }) } });
    expect(r).toEqual({ action: "enregistrer", jeton: { cible: "drive", id: "node-1", userId: "user-9", kind: "enregistrement" }, url });
  });
  it("lit aussi la signature en en-tête (corps enveloppé dans `payload`), schéma http toléré", () => {
    const url = "http://office.example.com/cache/x.docx";
    const r = lireRappelOnlyoffice({ ...base, jeton: jeton(), corps: { status: 2, url }, autorisation: `Bearer ${signe({ payload: { status: 6, url } })}` });
    expect(r.action).toBe("enregistrer");
  });
  it("REFUSE un corps non signé, même avec un jeton d'enregistrement valide", () => {
    const r = lireRappelOnlyoffice({ ...base, jeton: jeton(), corps: { status: 2, url: "https://office.example.com/x.docx" } });
    expect(r.action).toBe("refuser");
  });
  it("REFUSE une signature forgée avec un autre secret", () => {
    const vraiSecret = process.env.ONLYOFFICE_JWT_SECRET;
    process.env.ONLYOFFICE_JWT_SECRET = "secret-de-l-attaquant";
    const forge = signe({ status: 2, url: "https://office.example.com/x.docx" });
    process.env.ONLYOFFICE_JWT_SECRET = vraiSecret;
    expect(lireRappelOnlyoffice({ ...base, jeton: jeton(), corps: { token: forge } }).action).toBe("refuser");
  });
  it("REFUSE une adresse hors du Document Server (pas de téléchargement arbitraire)", () => {
    for (const url of ["https://attaquant.example.net/x.docx", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"]) {
      const r = lireRappelOnlyoffice({ ...base, jeton: jeton(), corps: { token: signe({ status: 2, url }) } });
      expect(r.action, url).toBe("refuser");
    }
  });
  it("REFUSE un jeton de LECTURE (celui qui part au navigateur dans `document.url`)", () => {
    const url = "https://office.example.com/x.docx";
    const r = lireRappelOnlyoffice({ ...base, jeton: makeFileReadToken("node-1", "user-9"), corps: { token: signe({ status: 2, url }) } });
    expect(r.action).toBe("refuser");
  });
  it("REFUSE un jeton qui désigne un autre fichier que celui de l'adresse", () => {
    const url = "https://office.example.com/x.docx";
    const r = lireRappelOnlyoffice({ ...base, id: "node-2", jeton: jeton(), corps: { token: signe({ status: 2, url }) } });
    expect(r.action).toBe("refuser");
  });
  it("les valeurs se lisent dans la partie SIGNÉE : un corps clair contradictoire est ignoré", () => {
    const url = "https://office.example.com/x.docx";
    const r = lireRappelOnlyoffice({ ...base, jeton: jeton(), corps: { status: 2, url: "https://attaquant.example.net/y", token: signe({ status: 2, url }) } });
    expect(r).toMatchObject({ action: "enregistrer", url });
  });
  it("acquitte sans effet les statuts autres que 2 et 6 (édition en cours, fermé sans modification)", () => {
    for (const status of [1, 4]) {
      expect(lireRappelOnlyoffice({ ...base, jeton: jeton(), corps: { token: signe({ status }) } }).action).toBe("ignorer");
    }
  });
});
