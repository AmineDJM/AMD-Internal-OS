import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { ModelReply } from "@/lib/models/contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SCÉNARIO EXACT DE LA DIRECTION (02/11, « catastrophique ») — lot B1, décision 0049.
 *
 * La pièce jointe « Devis matériel promotionnel INSIGNE.pdf » (fabriquée fidèlement : 27 lignes
 * numérotées en 3 blocs sur 3 pages, en-tête de colonnes et pied de page répétés, 794 500 DZD HT,
 * TVA 19 %, taxe publicitaire 2 %, client ADVENTUM PHARMA avec son NIF) est déposée au Drive.
 * « Crée un bc en pdf » → l'assistant appelle l'opération SANS validateur NI société. Le modèle de
 * lecture rend la lecture FAUTIVE du 02/11 (fournisseur Adventum, lignes manquantes, bloc répété).
 *
 * Attendu : fournisseur INSIGNE, société Adventum Pharma (le client du devis), 27 lignes justes,
 * HT 794 500, une carte lisible (pas de seuil de 0 DZD, pas de redite, pas d'enveloppe Regulatory),
 * aucune question ; « Créer le BC (PDF) » → BC brouillon numéroté + PDF au Drive ; l'annulation
 * (K10b) le passe à ANNULÉ — jamais effacé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
const modele = vi.hoisted(() => ({ data: null as unknown, appels: 0 }));
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async () => {
    modele.appels++;
    return { data: modele.data, reply: { ok: true, configured: true, stop: "end", blocks: [], usage: { role: "worker", model: "banc", provider: "openai", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ms: 1, attempts: 1, reasoningTokens: 0 } } as unknown as ModelReply };
  },
}));
vi.mock("@/lib/ai-settings", async (orig) => ({ ...(await orig<typeof import("@/lib/ai-settings")>()), aiFeatureEnabled: async () => true, interrupteurIaCoupe: async () => false, logAiUsage: async () => {} }));
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), aiConfigured: () => true, cleModeleRequise: () => "OPENAI_API_KEY" }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { journaliserGeste } from "@/lib/effets/journal";
import { annulerGeste } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import { DEVIS_INSIGNE, attendu, fichierDuDevis } from "@/lib/pieces-lues/banc/devis-fabriques";
import { BC_DEPUIS_DEVIS } from "./bc-depuis-devis";
import { executerOperationIA } from "./";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__b1dir${Date.now().toString(36)}_`;
let direction: CurrentUser;
let adventumId = "";
let regulatoryId = "";
let marketingId = "";
let devisId = "";

suite("Lot B1 — « Crée un bc en pdf » depuis le devis INSIGNE de la Direction", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}Direction`, email: `${TAG}dg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    direction = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
    ACTOR = direction;
    // La société du groupe, avec son NIF au registre : c'est par lui que le devis la désigne comme CLIENT.
    adventumId = (await prisma.company.create({ data: { name: `${TAG}Adventum Pharma`, shortName: `${TAG}ADV`, legalIdentity: { create: { nif: DEVIS_INSIGNE.client.nif, rcNumber: DEVIS_INSIGNE.client.rc } } } })).id;
    // L'annuaire contient ADVENTUM PHARMA (un client) avec le même NIF : le piège du 02/11.
    await prisma.companyContact.create({ data: { name: "ADVENTUM PHARMA", nif: DEVIS_INSIGNE.client.nif, kind: `${TAG}client`, createdById: u.id } });
    // Deux enveloppes : Regulatory, la plus récente ; Marketing, qui couvre le matériel promotionnel.
    regulatoryId = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Budget Regulatory`, domaine: "REGULATORY", modules: ["REGULATORY"], periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-12-31"), totalAmount: 5_000_000 } })).id;
    marketingId = (await prisma.budgetEnvelope.create({ data: { name: `${TAG}Budget Marketing`, domaine: "MARKETING", modules: ["PROMO_MATERIAL"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 20_000_000 } })).id;
    const { blobId, size } = await putBlob(await fichierDuDevis(DEVIS_INSIGNE));
    devisId = (await enregistrerFichierDrive(direction, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId, size, mimeType: "application/pdf", name: `${TAG}${DEVIS_INSIGNE.fichier}` })).id;
  }, 60_000);

  afterAll(async () => {
    const docs = await prisma.legalDocument.findMany({ where: { companyId: adventumId }, select: { id: true } });
    await prisma.documentReference.deleteMany({ where: { companyId: adventumId } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: [regulatoryId, marketingId] } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { OR: [{ kind: `${TAG}client` }, { createdById: direction?.id }] } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: direction?.id } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: direction?.id } }).catch(() => {});
    await prisma.lecturePiece.deleteMany({ where: { creeParId: direction?.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: adventumId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("aucune question : fournisseur INSIGNE, société Adventum, 27 lignes, 794 500 HT ; BC brouillon + PDF ; annulé, jamais effacé", async () => {
    // La lecture fautive du 02/11, rendue par le modèle s'il était appelé.
    modele.data = { type: "DEVIS", numero: "", date: "", devise: "DA", modePaiement: "", fournisseur: { nom: "ADVENTUM PHARMA", nif: DEVIS_INSIGNE.client.nif, rc: "", nis: "", ai: "", adresse: "" }, tvaDefaut: "19", remiseGlobale: "", taxes: [], lignes: [], totaux: { ht: "", tva: "", taxes: "", timbre: "", ttc: "" } };
    const p = await BC_DEPUIS_DEVIS.proposer({ fichier: devisId }, direction);
    if (!("carte" in p)) throw new Error(`une question a été posée : ${JSON.stringify(p)}`);
    const champ = (l: string) => p.carte.fields.find((f) => f.label === l)?.value ?? "";
    const a = attendu(DEVIS_INSIGNE);
    expect(p.carte.title).toMatch(/^Bon de commande — INSIGNE → /);
    expect(champ("Fournisseur")).toMatch(/^INSIGNE · NIF 001216098700412/);
    expect(champ("Société")).toBe(`${TAG}Adventum Pharma (client du devis)`);
    expect(champ("Lignes")).toBe("27 lignes");
    expect(champ("Total HT")).toMatch(/^794\s500 DZD$/);
    expect(champ("Total TTC")).toMatch(/^961\s345 DZD$/);
    expect(champ("Enveloppe proposée")).toMatch(new RegExp(`^${TAG}Budget Marketing \\(matériel promotionnel`));
    expect(champ("Validateur")).toBe("à désigner à l'envoi en validation");
    const detail = champ("Détail des lignes").split("\n");
    expect(detail).toHaveLength(27);
    expect(detail.map((l) => Number(l.split(".")[0]))).toEqual(a.lignes.map((l) => l.n));
    // Carte lisible : une provenance, ni seuil, ni Regulatory, ni écart (tout réconcilie).
    expect(p.carte.warnings).toEqual(["Lignes et montants lus sur le tableau du PDF, à vérifier contre le papier."]);
    expect(p.carte.libelleBouton).toBe("Créer le BC (PDF)");
    expect(modele.appels, "le tableau réconcilie : aucun appel au modèle").toBe(0);

    // « Créer le BC (PDF) », sous le journal des effets — comme une carte confirmée.
    const { resultat: r, gesteId } = await journaliserGeste(direction, { origine: "carte", capaciteId: `operation:${BC_DEPUIS_DEVIS.nom}`, libelle: BC_DEPUIS_DEVIS.libelle },
      () => executerOperationIA(direction, { kind: "assistant_ia_op", op: BC_DEPUIS_DEVIS.nom, args: p.args }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/créé en brouillon .* PDF « .*\.pdf » déposé au Drive/);
    const bc = await prisma.legalDocument.findFirstOrThrow({ where: { companyId: adventumId, kind: "PURCHASE_ORDER" } });
    expect(bc.counterparty).toBe("INSIGNE");
    expect(Number(bc.amount)).toBe(a.ttc);
    expect(bc.bcPrevalidationAt).not.toBeNull();
    expect(bc.bcPrevalidationRequestId, "pas de demande de validation : brouillon").toBeNull();
    const fab = (bc.custom as { fabrique: { pdf: { nodeId: string } | null; spec: { lignes: unknown[] } } }).fabrique;
    expect(fab.spec.lignes).toHaveLength(27);
    expect(fab.pdf).not.toBeNull();
    const pdf = await prisma.driveNode.findUniqueOrThrow({ where: { id: fab.pdf!.nodeId } });
    expect(pdf.mimeType).toBe("application/pdf");
    expect(r.link).toBe(`/api/drive/${encodeURIComponent(pdf.id)}/raw`);
    // La fiche INSIGNE a été créée à l'annuaire, avec SON NIF — pas celui du client.
    const fiche = await prisma.companyContact.findFirstOrThrow({ where: { name: "INSIGNE", createdById: direction.id } });
    expect(fiche.nif).toBe(DEVIS_INSIGNE.emetteur.nif);

    // RÉVERSIBLE (K10b) : la pièce numérotée passe à ANNULÉE, son numéro reste, rien n'est effacé.
    expect(gesteId).toBeTruthy();
    const an = await annulerGeste(gesteId!, direction);
    if ("refus" in an) throw new Error(an.refus);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc.id } });
    expect(apres.status).toBe("CANCELLED");
    expect(apres.reference).toBe(bc.reference);
    // TOUT LE RESTE EST DÉFAIT (Direction, 03/11 : « vérifie que ça marche bien, l'annulation ») : la fiche fournisseur
    // créée pour ce BC, le PDF déposé au Drive. Rien d'« impossible » : la lecture en cache du devis (partagée par
    // empreinte) n'est pas un effet du geste — elle faisait dire « ce n'est PAS une annulation complète ».
    expect(an.details.filter((d) => d.issue === "IMPOSSIBLE"), JSON.stringify(an.details.filter((d) => d.issue === "IMPOSSIBLE"))).toEqual([]);
    expect(an.resume).not.toMatch(/PAS une annulation complète/);
    expect(await prisma.companyContact.findUnique({ where: { id: fiche.id } }), "la fiche fournisseur créée pour ce BC est retirée").toBeNull();
    expect(await prisma.driveNode.findUnique({ where: { id: pdf.id } }), "le PDF déposé au Drive est retiré").toBeNull();
    // « RÉTABLIR » refait le geste : le BC redevient un brouillon actif, sa fiche fournisseur revient.
    const re = await retablirGeste(gesteId!, direction);
    if ("refus" in re) throw new Error(re.refus);
    expect(re.resume).toMatch(/^Rétabli/);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc.id } })).status).not.toBe("CANCELLED");
    expect(await prisma.companyContact.count({ where: { name: "INSIGNE", createdById: direction.id } })).toBe(1);
  }, 60_000);
});
