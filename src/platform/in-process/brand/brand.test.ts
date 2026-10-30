import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { getMyCompanies } from "@/lib/company";
import { definirLogo, definirMarque, marqueDe } from "./index";
import { profilDocumentaire } from "@/platform/ia/artifact/factory";
import { construireDocumentCommercial } from "@/lib/artifact/factory/build";
import { composerDocx, dimensionsImage, paragraphe } from "@/lib/artifact/factory/word";

/**
 * LE REGISTRE DE MARQUE, PAR LE PONT ET JUSQU'AU FICHIER (§14 : le vrai point d'entrée). Ce qu'on
 * prouve sur la vraie base : régler la marque exige de tenir la papeterie ; une modification
 * partielle est appliquée et relue ; le profil documentaire PORTE la marque et sa charte ; un
 * devis construit avec ce profil a l'accent dans ses styles, la mention et le signataire du
 * type dans son texte ; un logo PNG est accepté (un SVG refusé) et se retrouve dans l'en-tête du
 * paquet Word neuf ; et le nettoyage rend la société comme elle était.
 */
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let admin: CurrentUser | null = null;
let companyId: string | null = null;
let settingsAvant: unknown = null;
let profilExistait = false;
const salarie = { id: "brand-test-viewer", name: "Vue", email: "v@test.dz", role: "VIEWER", access: { modules: new Map() } } as unknown as CurrentUser;

beforeAll(async () => {
  const a = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN", isActive: true }, select: { id: true, name: true, email: true, role: true } });
  if (!a) return;
  admin = { ...a, access: { modules: new Map() } } as unknown as CurrentUser;
  const societes = await getMyCompanies(admin.id);
  if (!societes.length) return;
  companyId = societes[0].id;
  const p = await prisma.companyDocumentProfile.findUnique({ where: { companyId }, select: { settings: true } });
  profilExistait = Boolean(p);
  settingsAvant = p?.settings ?? null;
});

afterAll(async () => {
  if (!companyId) return;
  // La société ressort comme elle est entrée : le profil retrouve ses réglages, ou disparaît s'il n'existait pas.
  if (profilExistait) await prisma.companyDocumentProfile.update({ where: { companyId }, data: { settings: (settingsAvant ?? undefined) as object | undefined } }).catch(() => undefined);
  else await prisma.companyDocumentProfile.deleteMany({ where: { companyId } });
  await prisma.auditLog.deleteMany({ where: { summary: { contains: "Registre de marque de" } } }).catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { summary: { contains: "__brand__" } } }).catch(() => undefined);
});

describe("le registre de marque, par le pont", () => {
  it("un compte qui ne tient pas la papeterie lit mais ne règle pas", async () => {
    if (!companyId) return;
    const r = await definirMarque(salarie, { societe: companyId, modification: { couleurAccent: "#0B6E4F" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.echec).toBe("MISSING_PERMISSION");
  });

  it("régler, relire : une modification partielle s'applique, les refus sont nommés, l'audit porte le nom", async () => {
    if (!admin || !companyId) return;
    const r = await definirMarque(admin, {
      societe: companyId,
      modification: { couleurAccent: "#0B6E4F", policeTitres: "Georgia", couleurSecondaire: "pas-une-couleur", mentionsLegales: ["Agrément ANPP n° __brand__-042"], signatairesParType: { DEVIS: { nom: "Amel Haddad", qualite: "Directrice commerciale" } } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.champsModifies).toEqual(expect.arrayContaining(["couleur accent", "police des titres", "mentions légales", "signataire des devis"]));
    expect(r.refus.join(" ")).toMatch(/couleur secondaire « pas-une-couleur »/);
    expect(r.lue.marque.couleurs.accent).toBe("0B6E4F");
    expect(r.lue.charte).toMatchObject({ accent: "0B6E4F", origineAccent: "marque", policeTitres: "Georgia" });
    const relue = await marqueDe(admin, companyId);
    expect(relue.ok && relue.lue.marque.signatures.parType.DEVIS?.nom).toBe("Amel Haddad");
    const audit = await prisma.auditLog.findFirst({ where: { actorId: admin.id, summary: { contains: "Registre de marque de" } }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toMatch(/couleur accent/);
  });

  it("le profil documentaire PORTE la marque, et un devis construit avec lui l'applique : accent dans les styles, mention et signataire dans le texte", async () => {
    if (!admin || !companyId) return;
    const p = await profilDocumentaire(admin, companyId);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.profil.charte.accent).toBe("0B6E4F");
    expect(p.profil.societe.couleur).toBe("0B6E4F");
    expect(p.profil.resumeMarque).toMatch(/registre de marque/);
    // La spec telle que la fabrique la compose : on la rejoue ici sans numéroter ni écrire au registre.
    const { specDepuisDemandePourTest } = await import("@/platform/ia/artifact/factory");
    const spec = { ...specDepuisDemandePourTest({ type: "DEVIS", tiers: { nom: "Clinique __brand__" }, lignes: [{ designation: "Nivolex 10 mg/ml", quantite: 4, prixUnitaire: 85_000 }] }, p.profil), numero: "DEV-TEST-0001" };
    expect(spec.signataire).toEqual({ nom: "Amel Haddad", qualite: "Directrice commerciale" });
    expect(spec.piedDePage?.join(" ")).toMatch(/Agrément ANPP n° __brand__-042/);
    const construit = await construireDocumentCommercial(spec, { ...p.habillage, base: null });
    expect(construit.verification.ok, construit.verification.bloquants.join(" ; ")).toBe(true);
    const zip = new PizZip(construit.octets);
    const styles = zip.file("word/styles.xml")!.asText();
    const document = zip.file("word/document.xml")!.asText();
    expect(styles).toContain("0B6E4F");
    expect(styles).toContain('w:ascii="Calibri"');
    expect(document.replace(/<[^>]+>/g, " ")).toMatch(/Amel Haddad/);
    expect(document.replace(/<[^>]+>/g, " ")).toMatch(/Directrice commerciale/);
    expect(document.replace(/<[^>]+>/g, " ")).toMatch(/__brand__-042/);
  });

  it("le logo : un SVG est refusé, un PNG accepté, et il se retrouve dans l'en-tête d'un paquet Word neuf", async () => {
    if (!admin || !companyId) return;
    const svg = await definirLogo(admin, { societe: companyId, fichier: { nom: "logo.svg", mime: "image/svg+xml", octets: Buffer.from("<svg/>") } });
    expect(svg.ok).toBe(false);
    if (!svg.ok) expect(svg.motif).toMatch(/PNG ou un JPEG/);
    const menteur = await definirLogo(admin, { societe: companyId, fichier: { nom: "logo.png", mime: "image/png", octets: Buffer.from("pas une image") } });
    expect(menteur.ok).toBe(false);
    const png = await definirLogo(admin, { societe: companyId, fichier: { nom: "logo-__brand__.png", mime: "image/png", octets: PNG_1PX, largeurCm: 3 } });
    expect(png.ok).toBe(true);
    if (!png.ok) return;
    expect(png.lue.marque.logo).toMatchObject({ nom: "logo-__brand__.png", mime: "image/png", taille: PNG_1PX.length, largeurCm: 3 });
    // La marque réglée avant le logo est INTACTE : déposer un logo ne remet pas la charte à zéro.
    expect(png.lue.marque.couleurs.accent).toBe("0B6E4F");
    const p = await profilDocumentaire(admin, companyId);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    if (p.papierOctets) return; // la société a un papier en-tête : le logo n'y est pas injecté, par dessein
    expect(p.logo?.png).toBe(true);
    const { octets } = composerDocx({ blocs: [paragraphe("Bonjour")], logo: p.logo, titre: "t" });
    const zip = new PizZip(octets);
    expect(zip.file("word/header1.xml")).toBeTruthy();
    expect(zip.file("word/media/logo.png")).toBeTruthy();
    expect(zip.file("[Content_Types].xml")!.asText()).toContain('Extension="png"');
    expect(zip.file("word/document.xml")!.asText()).toContain("headerReference");
    expect(dimensionsImage(PNG_1PX, true)).toEqual({ largeur: 1, hauteur: 1 });
    const retire = await definirLogo(admin, { societe: companyId, fichier: null });
    expect(retire.ok && retire.lue.marque.logo).toBeNull();
  });
});
