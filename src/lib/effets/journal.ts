import type { CurrentUser } from "@/lib/session";
import { prismaBrut } from "@/lib/prisma";
import { journaliser } from "@/lib/journal";
import { clientCapturant } from "./client";
import { consolider, empreinteDe } from "./diff";
import { avecStoreHorsRequete, etatPour } from "./geste";
import { etatDuGeste, sousGeste, type Capture, type EcritureCapturee, type OrigineGeste } from "./magasin";
import { finaliserCapture } from "./capture";
import { installerPortReseau } from "./reseau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JOURNAL DES EFFETS (J7, décision 0029) — tout geste d'agent garde la valeur AVANT de ce qu'il touche.
 *
 * Une carte confirmée, l'étape d'un travail, un geste sous mandat : chacun passe par `journaliserGeste`. Le geste
 * s'exécute en mode RÉEL, sur le client qui capture (`capture.ts`) : chaque écriture laisse sa ligne avant et sa
 * ligne après, chaque effet externe (courriel, poussée, stockage, site, appel réseau) son passage. À la fin — succès
 * ou échec — le geste et ses effets entrent au journal (`AssistantGesteJournal`, `AssistantEffet`), hors du geste,
 * sur le client de base : le journal ne se journalise pas.
 *
 * C'est la matière de l'annulation (`annulation.ts` → `annulation/plan.ts`) et de l'écran « Ce que l'assistant a
 * fait ». Un geste imbriqué dans un geste déjà journalisé (le travail qui appelle l'opération) n'ouvre pas de
 * seconde entrée : ses écritures vont à celle du geste qui le contient.
 *
 * L'EMPREINTE du réel est comparée à celle que la carte a montrée (`empreinteSimulee`) : un écart est NOTÉ (le
 * monde a changé entre la vérification et l'écriture), et l'écran le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MetaGesteAgent {
  origine: Extract<OrigineGeste, "carte" | "travail" | "mandat"> | "carte" | "travail" | "mandat";
  capaciteId?: string | null;
  libelle: string;
  travailId?: string | null;
  etape?: string | null;
  cleIdempotence?: string | null;
  empreinteSimulee?: string | null;
}

type Resultat = { ok?: boolean; error?: string; message?: string } | unknown;

const lireIssue = (r: Resultat): { ok: boolean; message: string | null } => {
  if (r && typeof r === "object" && "ok" in r) {
    const o = r as { ok?: unknown; error?: unknown; message?: unknown };
    const message = typeof o.error === "string" ? o.error : typeof o.message === "string" ? o.message : null;
    return { ok: o.ok !== false, message };
  }
  return { ok: true, message: null };
};

/** Durée de garde par défaut du journal (jours) — réglable dans la console (`retentionEffetsJours`). */
export const RETENTION_EFFETS_JOURS = 180;

/**
 * EXÉCUTE un geste d'agent sous journal. `user` : la personne (principal). `horsRequete` : la rendre à `requireUser`
 * (worker, mandat) — dans une requête, sa session suffit.
 */
export async function journaliserGeste<T extends Resultat>(
  user: CurrentUser,
  meta: MetaGesteAgent,
  geste: () => Promise<T>,
  opts: { horsRequete?: boolean } = {},
): Promise<{ resultat: T; gesteId: string | null; ecart: boolean }> {
  const parent = etatDuGeste();
  // Déjà sous un geste capturé (ou une simulation) : ses écritures vont au geste qui le contient.
  if (parent?.capture) return { resultat: await geste(), gesteId: null, ecart: false };
  installerPortReseau();
  const capture: Capture = { ecritures: [], effets: [] };
  const debut = Date.now();
  const etat = {
    ...etatPour(opts.horsRequete ? user : null, { origine: meta.origine, mode: "REEL", travailId: meta.travailId, etape: meta.etape, cleIdempotence: meta.cleIdempotence }),
    mode: "REEL" as const, principalId: user.id, capture, client: clientCapturant(), debut,
  };
  let resultat: T | undefined;
  let leve: unknown = null;
  try {
    // Hors requête, l'action trouve aussi le « work store » de Next (ses `revalidatePath` y sont gardés, `contexte-geste.ts`).
    resultat = opts.horsRequete ? (await sousGeste(etat, () => avecStoreHorsRequete(meta.origine, geste))).resultat : await sousGeste(etat, geste);
  } catch (e) {
    leve = e;
  }
  const issue = leve ? { ok: false, message: leve instanceof Error ? leve.message : String(leve) } : lireIssue(resultat);
  // Le CALME (une promesse « au mieux » finit d'écrire) et l'état FINAL des lignes touchées, avant d'inscrire.
  await finaliserCapture(capture, prismaBrut as unknown as Record<string, unknown>);
  const gesteId = await inscrire(user.id, meta, capture, issue, { debut, fin: Date.now() });
  // Ce qui s'écrirait encore sous ce geste (au-delà du calme) va au journal, à la suite : rien ne lui échappe.
  if (gesteId) {
    let ordre = capture.ecritures.length + capture.effets.length;
    capture.tardive = (e) => {
      void prismaBrut.assistantEffet.create({ data: { gesteId: gesteId.id, ...effetEnLigne(e, ordre++) } })
        .catch((err) => journaliser("erreur", "effets.journal-tardif", { gesteId: gesteId.id }, err));
    };
  }
  if (leve) throw leve;
  return { resultat: resultat as T, gesteId: gesteId?.id ?? null, ecart: gesteId?.ecart ?? false };
}

const effetEnLigne = (e: EcritureCapturee, ordre: number) => ({
  ordre, type: "ECRITURE", modele: e.modele, operation: e.operation, enregistrementId: e.id,
  avant: (e.avant ?? undefined) as never, apres: (e.apres ?? undefined) as never, champs: e.champs,
  cascade: e.cascade ?? null, nombre: e.nombre ?? null, imbriquee: !!e.imbriquee,
});

async function inscrire(
  principalId: string, meta: MetaGesteAgent, capture: Capture, issue: { ok: boolean; message: string | null },
  fenetre: { debut: number; fin: number },
): Promise<{ id: string; ecart: boolean } | null> {
  try {
    const ecritures = consolider(capture.ecritures);
    // Un geste en échec qui n'a rien écrit n'a rien à défaire — il reste au journal pour l'historique.
    const empreinte = empreinteDe(capture, fenetre);
    const ecart = Boolean(issue.ok && meta.empreinteSimulee && meta.empreinteSimulee !== empreinte);
    const g = await prismaBrut.assistantGesteJournal.create({
      data: {
        principalId, origine: meta.origine, capaciteId: meta.capaciteId ?? null, libelle: meta.libelle.slice(0, 300),
        travailId: meta.travailId ?? null, etape: meta.etape ?? null, cleIdempotence: meta.cleIdempotence ?? null,
        resultat: issue.ok ? "FAIT" : "ECHEC", message: issue.message?.slice(0, 1000) ?? null,
        empreinte, empreinteSimulee: meta.empreinteSimulee ?? null, ecart,
        effets: {
          create: [
            ...ecritures.map((e, i) => effetEnLigne(e, i)),
            ...capture.effets.map((f, i) => ({
              ordre: ecritures.length + i, type: "EXTERNE", acte: f.acte, cible: f.cible.slice(0, 500), apercu: f.apercu?.slice(0, 500) ?? null,
            })),
          ],
        },
      },
      select: { id: true },
    });
    if (ecart) journaliser("avertissement", "effets.ecart-simulation", { gesteId: g.id, capacite: meta.capaciteId ?? null });
    return { id: g.id, ecart };
  } catch (e) {
    // Le geste A EU LIEU : un journal qui échoue ne le défait pas — il le dit, fort.
    journaliser("erreur", "effets.journal", { capacite: meta.capaciteId ?? null, origine: meta.origine }, e);
    return null;
  }
}

/** Le journal au-delà de sa durée de garde, retiré (tâche de fond). */
export async function purgerJournalDesEffets(maintenant = new Date()): Promise<number> {
  const reglage = await prismaBrut.assistantIaReglage.findUnique({ where: { id: "global" }, select: { retentionEffetsJours: true } }).catch(() => null);
  const jours = Math.max(7, reglage?.retentionEffetsJours ?? RETENTION_EFFETS_JOURS);
  const r = await prismaBrut.assistantGesteJournal.deleteMany({ where: { creeLe: { lt: new Date(maintenant.getTime() - jours * 86_400_000) } } });
  return r.count;
}
