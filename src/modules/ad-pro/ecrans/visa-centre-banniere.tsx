import type { EntityType } from "@prisma/client";
import type { SessionUser } from "@/lib/rbac";
import { lireVisaDetail, montantPourLeVisa } from "../infra/visa";
import { peutResoumettreAuCentre } from "../infra/requetes/centre";
import { ResoumettreAuCentre } from "./resoumettre-au-centre";

/**
 * L'ÉTAT DU CENTRE DE VALIDATION AD & PRO SUR LA FICHE (audit 360°, R07/R10).
 *
 * Le visa ne se voyait nulle part : la demande s'arrêtait au centre, et son demandeur ne l'apprenait
 * qu'en voyant son approbateur refuser de trancher. La fiche dit maintenant où elle en est — en
 * attente, autorisée, refusée, ou À CORRIGER, avec le motif et le geste qui la fait revenir.
 */
export async function VisaCentreBanniere({ entityType, entityId, viewer }: {
  entityType: EntityType; entityId: string; viewer: SessionUser;
}) {
  const v = await lireVisaDetail(entityType, entityId);
  if (!v) return null;
  const qui = [v.decideur, v.decidedAt ? v.decidedAt.toLocaleDateString("fr-FR") : null].filter(Boolean).join(" · ");
  if (v.etat === "PENDING") {
    return (
      <div className="rounded-xl border border-warning/40 bg-warning/5 px-3 py-3 text-sm [overflow-wrap:anywhere] sm:px-4">
        <p className="font-medium">Centre de validation Ad &amp; Pro : en attente d&apos;arbitrage</p>
        <p className="text-muted-foreground">Au-dessus du seuil, la demande attend la Direction Générale ou le Super Admin.{v.note ? ` — ${v.note}` : ""}</p>
      </div>
    );
  }
  if (v.etat === "APPROVED") {
    return (
      <div className="rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere] sm:px-4">
        Centre de validation Ad &amp; Pro : dépassement du seuil autorisé{qui ? ` (${qui})` : ""}.
      </div>
    );
  }
  if (v.etat === "REFUSED") {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm [overflow-wrap:anywhere] sm:px-4">
        <p className="font-medium">Centre de validation Ad &amp; Pro : refusée{qui ? ` (${qui})` : ""}</p>
        <p>Motif : « {v.note ?? "non renseigné"} ». Seul un siège du centre peut la réexaminer.</p>
      </div>
    );
  }
  // LA MÊME règle que l'action (`peutResoumettreAuCentre`) : un bouton offert à qui l'action refusera
  // fait chercher une panne qui n'existe pas (§118.83).
  const peutResoumettre = await peutResoumettreAuCentre(viewer, entityType, entityId);
  return (
    <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-3 text-sm [overflow-wrap:anywhere] sm:px-4">
      <p className="font-medium">Centre de validation Ad &amp; Pro : à corriger{qui ? ` (${qui})` : ""}</p>
      <p>À corriger : « {v.note ?? "non renseigné"} ».</p>
      {peutResoumettre
        ? <ResoumettreAuCentre entityType={entityType} entityId={entityId} montant={await montantPourLeVisa(entityType, entityId)} />
        : <p className="text-muted-foreground">Son demandeur la corrige puis la resoumet au centre.</p>}
    </div>
  );
}
