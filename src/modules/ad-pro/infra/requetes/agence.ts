import { prisma } from "@/lib/prisma";
import { lireStatutConformite, type AgenceVue } from "../../domaine/parcours-agence";
import type { PiecesDuPoste } from "../pieces-poste";
import type { DevisDePosteVue } from "./devis-poste";

/** L'étape du dépôt du BAT d'un poste (pièce jointe du poste, `entityType` AD_PRO_ITEM). */
export const ETAPE_BAT = "BAT_CONFORMITE";
/** Les photos et le PV de réception d'un poste. */
export const ETAPE_RECEPTION = "PV_RECEPTION";

/**
 * L'EXÉCUTION DES POSTES « PAR UNE AGENCE », en LOT (Direction, 15/11/2026) — l'horodatage de chaque étape, la signature de
 * la Direction Marketing sur le BC, le brouillon du BC, le dernier BAT. Une poignée de requêtes pour tout l'écran.
 */
export async function agencesDesPostes(
  items: readonly { id: string; voie: string | null; conformiteRequise: boolean }[],
  pieces: Map<string, PiecesDuPoste>,
  devis: Map<string, DevisDePosteVue[]>,
): Promise<Map<string, AgenceVue>> {
  const res = new Map<string, AgenceVue>();
  const agence = items.filter((i) => i.voie === "AGENCE");
  if (agence.length === 0) return res;
  const ids = agence.map((i) => i.id);
  const bcIds = ids.map((id) => pieces.get(id)?.bc?.id).filter((x): x is string => Boolean(x));
  const [execs, signatures, bats] = await Promise.all([
    prisma.adProExecutionPoste.findMany({ where: { itemId: { in: ids } } }),
    bcIds.length ? prisma.signatureBC.findMany({ where: { legalDocumentId: { in: bcIds } }, orderBy: { signedAt: "asc" } }) : Promise.resolve([]),
    prisma.document.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: ids }, stepKey: ETAPE_BAT }, select: { id: true, name: true, entityId: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const assistantes = [...new Set(execs.map((e) => e.assistanteId).filter((x): x is string => Boolean(x)))];
  const noms = new Map((assistantes.length ? await prisma.user.findMany({ where: { id: { in: assistantes } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  const execDe = new Map(execs.map((e) => [e.itemId, e]));
  for (const i of agence) {
    const e = execDe.get(i.id) ?? null;
    const bcId = pieces.get(i.id)?.bc?.id ?? null;
    const sigs = bcId ? signatures.filter((s) => s.legalDocumentId === bcId) : [];
    const retenu = e?.agenceDevisId ? (devis.get(i.id) ?? []).find((d) => d.pieceId === e.agenceDevisId) ?? null : null;
    const bat = bats.find((b) => b.entityId === i.id) ?? null;
    res.set(i.id, {
      faits: {
        prospectionDemandee: Boolean(e?.prospectionDemandeeAt),
        devisTransmis: Boolean(e?.devisTransmisAt),
        agenceRetenue: Boolean(e?.agenceRetenueAt),
        brouillonBc: Boolean(retenu?.brouillon),
        bcSoumis: Boolean(e?.bcSoumisAt),
        signatureMarketing: sigs.some((s) => s.qualite === "DIRECTION_MARKETING"),
        bcEnvoye: Boolean(e?.bcEnvoyeAt),
        conformiteRequise: i.conformiteRequise,
        conformite: lireStatutConformite(e?.conformiteStatut),
        receptionFaite: Boolean(e?.receptionAt),
        assistante: e?.assistanteId ? noms.get(e.assistanteId) ?? null : null,
      },
      assistanteId: e?.assistanteId ?? null,
      cahierDesCharges: e?.cahierDesCharges ?? null,
      agenceDevisId: e?.agenceDevisId ?? null,
      agenceNom: retenu?.fournisseur ?? null,
      conformiteNote: e?.conformiteNote ?? null,
      receptionNote: e?.receptionNote ?? null,
      receptionReserve: e?.receptionReserve ?? false,
      bcId,
      signatures: sigs.map((s) => ({ qualite: s.qualite, nom: s.signataireNom, le: s.signedAt.toISOString(), jeton: s.jeton })),
      bat: bat ? { id: bat.id, nom: bat.name } : null,
    });
  }
  return res;
}
