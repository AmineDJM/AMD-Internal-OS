/**
 * Fabrique de documents — LE DOSSIER À TROIS FORMATS : Excel, PowerPoint et Word d'un même contenu
 * (`construireDossierDrive`).
 */
import type { CurrentUser } from "@/lib/session";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { construireDossier } from "@/lib/artifact/factory/dossier";
import type { DonneesCanoniques } from "@/lib/artifact/factory/canonical";
import { MIME_DOCX } from "@/lib/artifact/factory/word";
import { MIME_XLSX } from "@/lib/artifact/adapters/xlsx/adapter";
import { MIME_PPTX } from "@/lib/artifact/adapters/pptx/adapter";
import { echec, type EchecFabrique, type Habillage, manquesDIdentite, profilDocumentaire } from "./profil";

// ─────────────────────────── Le dossier à trois formats ───────────────────────────

export interface DossierEmis {
  ok: true;
  classeur: { nodeId: string; nom: string; formules: number };
  deck: { nodeId: string; nom: string; diapos: number };
  note: { nodeId: string; nom: string; pages: number };
  coherence: { totauxCompares: number };
  avertissements: string[];
  ms: number;
}

/**
 * CONSTRUIT le dossier (classeur + deck + note) depuis les données canoniques et l'écrit dans le
 * Drive — les trois fichiers, ou aucun. La société nommée fournit sa couleur et son papier.
 */
export async function construireDossierDrive(
  user: CurrentUser, opts: { nom: string; canon: DonneesCanoniques; societe?: string | null; dossier?: string | null },
): Promise<DossierEmis | EchecFabrique> {
  const debut = Date.now();
  let canon = opts.canon;
  let papier: Buffer | null = null;
  let habillage: Habillage | null = null;
  // Un dossier exécutif porte la charte de la société ou dit qu'il ne la porte pas — même règle
  // que les pièces commerciales : un livrable neutre présenté comme « le vôtre » est un faux succès.
  const manques: string[] = [];
  if (opts.societe) {
    const p = await profilDocumentaire(user, opts.societe);
    if (!p.ok) return p;
    papier = p.papierOctets;
    habillage = p.habillage;
    manques.push(...manquesDIdentite(p.profil));
    // La charte de la société (marque > bleu canard) colore le dossier ; une couleur demandée
    // explicitement dans les données canoniques garde la main.
    canon = { ...canon, societe: { nom: p.profil.identite.nom, couleur: canon.societe?.couleur ?? p.profil.societe.couleur } };
  }
  if (!canon.societe?.nom) canon = { ...canon, societe: { nom: user.name ?? "Adam", couleur: null } };
  const d = await construireDossier(canon, { base: papier, police: habillage?.police ?? null, logo: habillage?.logo ?? null });
  if (!d.ok) return echec("CAPABILITY_FAILURE", `Le dossier n'a pas été écrit : ${d.bloquants.slice(0, 5).join(" ; ")}`, { bloquants: d.bloquants });
  const nom = opts.nom.trim().replace(/\.(xlsx|pptx|docx)$/i, "") || canon.titre.trim() || "Dossier Adam";
  const dossier = opts.dossier?.trim() || undefined;
  const [classeur, deck, note] = await Promise.all([
    portsArtefact.documents.creerFichier(user.id, { nom: `${nom}.xlsx`, octets: d.classeur.octets, mime: MIME_XLSX, dossier }),
    portsArtefact.documents.creerFichier(user.id, { nom: `${nom}.pptx`, octets: d.deck.octets, mime: MIME_PPTX, dossier }),
    portsArtefact.documents.creerFichier(user.id, { nom: `${nom}.docx`, octets: d.note.octets, mime: MIME_DOCX, dossier }),
  ]);
  await portsArtefact.audit.tracer({
    userId: user.id, action: "dossier_build", cible: note.nodeId,
    detail: `dossier « ${nom} » construit en trois formats, cohérence vérifiée sur ${d.coherence?.totauxCompares ?? 0} total(aux)`,
  });
  return {
    ok: true,
    classeur: { nodeId: classeur.nodeId, nom: `${nom}.xlsx`, formules: d.classeur.verification?.formules ?? 0 },
    deck: { nodeId: deck.nodeId, nom: `${nom}.pptx`, diapos: d.deck.verification?.diapos ?? 0 },
    note: { nodeId: note.nodeId, nom: `${nom}.docx`, pages: d.note.verification?.pages ?? 0 },
    coherence: { totauxCompares: d.coherence?.totauxCompares ?? 0 },
    avertissements: [...d.avertissements, ...manques], ms: Date.now() - debut,
  };
}
