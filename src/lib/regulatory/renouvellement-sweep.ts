import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { anyRoleFilter, getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { sansBloquer } from "@/lib/journal";
import { ajouterMois, libellePalier, palierAPrevenir, PALIER_EXPIREE, PALIERS_ALERTE_MOIS } from "@/lib/regulatory/validite-enregistrement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BALAYAGE DES RENOUVELLEMENTS DE DÉCISION D'ENREGISTREMENT (Super Admin, 24/11/2026).
 *
 * La règle (paliers 12 / 6 / 1 mois avant la fin, puis « expirée ») vit dans
 * `validite-enregistrement.ts`, PURE et testée ; ce module pose la question à chaque passage du
 * planificateur et prévient À L'ENTRÉE d'un palier, une seule fois par palier et par fin de
 * validité — une alerte quotidienne est une alerte qu'on coupe.
 *
 * QUI : le Responsable réglementaire (HEAD_OF_REGULATORY) et le responsable du dossier — chacun
 * seulement s'il VOIT le dossier (un dossier verrouillé ne se révèle pas par une notification).
 *
 * ── CE QUI DIFFÈRE DU BALAYAGE LEGAL, EXPRÈS ─────────────────────────────────────────────
 *
 * Le balayage Legal lit au plus 300 documents, les expirés d'abord : au-delà, une échéance proche
 * n'est jamais lue. Ici, ce qui ARRIVE à échéance passe d'abord (fin la plus proche en tête), puis
 * les expirés ; la lecture se fait par pages jusqu'au bout — aucune borne ne fait oublier un dossier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PAGE = 200;

export interface RenouvellementSweepResult {
  alertes: number;
  notifies: number;
}

type Dossier = {
  id: string; reference: string; dci: string; brandName: string | null; responsibleId: string | null;
  registrationValidUntil: Date | null; renewalAlertTier: number | null; renewalAlertUntil: Date | null;
};

const SELECT = {
  id: true, reference: true, dci: true, brandName: true, responsibleId: true,
  registrationValidUntil: true, renewalAlertTier: true, renewalAlertUntil: true,
} as const;

/** Les dossiers d'un côté de « maintenant », par pages, la fin la plus proche de maintenant d'abord. */
async function* parPages(where: object, ordre: "asc" | "desc"): AsyncGenerator<Dossier[]> {
  let curseur: string | undefined;
  for (;;) {
    const lot: Dossier[] = await prisma.regulatoryProduct.findMany({
      where, select: SELECT,
      orderBy: [{ registrationValidUntil: ordre }, { id: "asc" }],
      take: PAGE, ...(curseur ? { skip: 1, cursor: { id: curseur } } : {}),
    });
    if (lot.length === 0) return;
    yield lot;
    if (lot.length < PAGE) return;
    curseur = lot[lot.length - 1].id;
  }
}

function message(d: Dossier, palier: number): { title: string; body: string } {
  const nom = d.brandName ? `${d.brandName} (${d.dci})` : d.dci;
  const fin = d.registrationValidUntil!.toLocaleDateString("fr-FR", { timeZone: "UTC" });
  if (palier === PALIER_EXPIREE) {
    return {
      title: `Décision d'enregistrement expirée — ${d.reference}`,
      body: `La décision d'enregistrement de ${nom} a expiré le ${fin}. Lancez le renouvellement depuis le dossier.`,
    };
  }
  return {
    title: `Renouvellement de la DE ${libellePalier(palier)} — ${d.reference}`,
    body: `La décision d'enregistrement de ${nom} expire le ${fin}. Le dossier de renouvellement se dépose 180 jours avant : lancez-le depuis le dossier.`,
  };
}

/** Un passage. Ne lève jamais : le planificateur ne doit pas mourir d'un rappel. */
export async function runRenouvellementSweep(now: Date = new Date()): Promise<RenouvellementSweepResult> {
  const out: RenouvellementSweepResult = { alertes: 0, notifies: 0 };
  try {
    const horizon = ajouterMois(now, Math.max(...PALIERS_ALERTE_MOIS));
    const responsables = await prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(["HEAD_OF_REGULATORY"]) }, select: { id: true } });
    // L'accès de chaque destinataire, résolu une fois par passage.
    const sessions = new Map<string, SessionUser | null>();
    const sessionDe = async (id: string): Promise<SessionUser | null> => {
      if (!sessions.has(id)) {
        const u = await prisma.user.findUnique({ where: { id }, select: { role: true, secondaryRole: true, isActive: true } });
        sessions.set(id, u?.isActive ? { id, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(id, u.role) } : null);
      }
      return sessions.get(id) ?? null;
    };

    const sources = [
      parPages({ registrationValidUntil: { gte: now, lte: horizon } }, "asc"), // à venir : la plus proche d'abord
      parPages({ registrationValidUntil: { lt: now } }, "desc"), // expirées : la plus récente d'abord
    ];
    for (const source of sources) {
      for await (const lot of source) {
        for (const d of lot) {
          const palier = palierAPrevenir({ fin: d.registrationValidUntil, maintenant: now, dernierPalier: d.renewalAlertTier, finPrevenue: d.renewalAlertUntil });
          if (palier === null) continue;
          // LE VERROU : marquer AVANT d'envoyer, sous condition de l'état lu — deux passages simultanés n'envoient pas deux fois.
          const pris = await prisma.regulatoryProduct.updateMany({
            where: { id: d.id, renewalAlertTier: d.renewalAlertTier, renewalAlertUntil: d.renewalAlertUntil, registrationValidUntil: d.registrationValidUntil },
            data: { renewalAlertTier: palier, renewalAlertUntil: d.registrationValidUntil },
          });
          if (pris.count === 0) continue;
          out.alertes++;
          const m = message(d, palier);
          const candidats = [...new Set([d.responsibleId, ...responsables.map((r) => r.id)].filter((x): x is string => Boolean(x)))];
          for (const userId of candidats) {
            const su = await sessionDe(userId);
            if (!su || !(await canAccessEntity(su, "REGULATORY_PRODUCT", d.id, "VIEW"))) continue;
            await notifyUser({
              userId, type: palier === PALIER_EXPIREE ? "LATE" : "DEADLINE_NEAR", title: m.title, body: m.body,
              link: `/regulatory/${d.id}#enregistrement`,
            }).catch(sansBloquer("renouvellement-sweep.notifyUser"));
            out.notifies++;
          }
        }
      }
    }
  } catch (err) {
    console.error("[regulatory] balayage des renouvellements de DE échoué", err);
  }
  return out;
}
