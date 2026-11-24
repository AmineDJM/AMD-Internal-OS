import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";

// Le bucket, simulé en mémoire : on vérifie la logique d'extraction, pas le réseau.
const bucket = new Map<string, Buffer>();
const appels = { head: 0, put: 0 };
vi.mock("@/lib/storage/object-storage", () => ({
  headObjectSize: async (cle: string) => { appels.head++; return bucket.get(cle)?.length ?? null; },
  putObjectStream: async (cle: string, source: AsyncIterable<Buffer>) => {
    appels.put++;
    const morceaux: Buffer[] = [];
    for await (const m of source) morceaux.push(m);
    bucket.set(cle, Buffer.concat(morceaux)); // l'objet n'apparaît qu'une fois complet, comme un multipart finalisé
  },
  presignGetUrl: (cle: string, _exp: number, q: Record<string, string>) => `https://bucket.test/${cle}?${new URLSearchParams(q)}`,
  VALIDITE_MAX_LECTURE_S: 300,
}));

const { assurerApercu, etatApercu, apercuDisponible, adresseApercu } = await import("./zip-apercu");
const { listerZip, sourceTampon, ErreurZip } = await import("./zip-lecteur");

async function archive(contenu: Buffer) {
  const z = new JSZip();
  z.file("dossier/gros.pdf", contenu);
  const buf = await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const src = sourceTampon(buf);
  const { entrees } = await listerZip(src);
  return { src, entree: entrees.find((e) => e.chemin === "dossier/gros.pdf")! };
}

describe("cache d'aperçu des entrées d'archive", () => {
  beforeEach(() => { bucket.clear(); appels.head = 0; appels.put = 0; });

  it("extrait UNE fois, même sous des demandes simultanées, et l'objet est l'entrée exacte", async () => {
    const contenu = Buffer.from("%PDF-1.7 ".repeat(200_000));
    const { src, entree } = await archive(contenu);
    expect(entree.crc32).not.toBe(0);
    await Promise.all([
      assurerApercu("apercus-zip/a/1.pdf", src, entree, "application/pdf"),
      assurerApercu("apercus-zip/a/1.pdf", src, entree, "application/pdf"),
      etatApercu("apercus-zip/a/1.pdf", src, entree, "application/pdf"),
    ]);
    expect(appels.put).toBe(1);
    expect(bucket.get("apercus-zip/a/1.pdf")!.equals(contenu)).toBe(true);
    // Déjà prête : ni HEAD, ni nouvelle extraction.
    const head = appels.head;
    expect(await etatApercu("apercus-zip/a/1.pdf", src, entree, "application/pdf")).toMatchObject({ pret: true });
    await assurerApercu("apercus-zip/a/1.pdf", src, entree, "application/pdf");
    expect(appels.head).toBe(head);
    expect(appels.put).toBe(1);
  });

  it("reconnaît une entrée déjà extraite (autre instance, redémarrage) sans la refaire", async () => {
    const contenu = Buffer.from("x".repeat(50_000));
    const { src, entree } = await archive(contenu);
    bucket.set("apercus-zip/b/2.pdf", contenu);
    expect(await apercuDisponible("apercus-zip/b/2.pdf", entree.taille)).toBe(true);
    await assurerApercu("apercus-zip/b/2.pdf", src, entree, "application/pdf");
    expect(appels.put).toBe(0);
    expect(await apercuDisponible("apercus-zip/c/absent.pdf", 10)).toBe(false);
  });

  it("une entrée tronquée n'est jamais publiée comme aperçu", async () => {
    const { src, entree } = await archive(Buffer.from("y".repeat(10_000)));
    const menteuse = { ...entree, taille: entree.taille + 1 }; // annonce un octet de plus qu'elle n'en contient
    await expect(assurerApercu("apercus-zip/d/3.pdf", src, menteuse, "application/pdf")).rejects.toBeInstanceOf(ErreurZip);
    expect(bucket.has("apercus-zip/d/3.pdf")).toBe(false);
    // L'échec se souvient : l'état le dit au lieu de relancer.
    expect((await etatApercu("apercus-zip/d/3.pdf", src, menteuse, "application/pdf")).echec?.zip).toBe(true);
  });

  it("signe une adresse qui impose le nom et le type de l'entrée", () => {
    const url = adresseApercu("apercus-zip/a/1.pdf", "Évaluation.pdf", "application/pdf", false)!;
    const q = new URL(url).searchParams;
    expect(q.get("response-content-type")).toBe("application/pdf");
    expect(q.get("response-content-disposition")).toMatch(/^inline; .*filename\*=UTF-8''%C3%89valuation\.pdf/);
  });
});
