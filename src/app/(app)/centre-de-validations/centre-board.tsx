"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, Gavel, AlarmClock } from "lucide-react";
import type { PendingValidationItem } from "@/lib/queries/validations";
import { centreCounters } from "@/lib/validations/centre";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { DocumentList } from "@/components/documents/document-list";
import { PRIORITY, libelleNatureValidation } from "@/lib/labels";
import { formatCurrency, formatDate, formatDateTime, daysUntil } from "@/lib/utils";
import { ValidationDecision } from "../validations/validation-decision";
import { AvisSurLeMessage } from "../validations/validation-item-review";
import { ValidationAttachments } from "../validations/validation-attachments";

export type CentreRow = PendingValidationItem;

type Filtre = "TOUT" | "A_DECIDER" | "RETARD" | "DORMANTES";

const FILTRES: { id: Filtre; label: string }[] = [
  { id: "A_DECIDER", label: "À décider" },
  { id: "RETARD", label: "En retard" },
  { id: "DORMANTES", label: "Sans décision depuis 7 j" },
  { id: "TOUT", label: "Tout" },
];

const DORMANT_MS = 7 * 86_400_000;

/**
 * LE TABLEAU DU CENTRE — décider, sans quitter l'écran.
 *
 * Les compteurs de l'en-tête sont des FILTRES : on clique « en retard » et il ne reste que
 * cela. Le filtre par défaut est « à décider », parce que c'est la seule pile qui bloque
 * quelqu'un — les demandes en attente d'un validateur précédent restent accessibles d'un clic,
 * mais ne s'imposent pas.
 *
 * Le groupement par MODULE n'est pas décoratif : décider huit contrats à la suite puis six
 * dépenses demande moins d'effort que d'alterner — on garde le même cadre de lecture.
 */
export function ValidationCentreBoard({ rows }: { rows: CentreRow[] }) {
  const [filtre, setFiltre] = React.useState<Filtre>("A_DECIDER");
  const now = React.useMemo(() => Date.now(), []);
  const compte = centreCounters(rows, new Date(now));

  const garde = React.useCallback(
    (r: CentreRow) => {
      if (filtre === "TOUT") return true;
      if (!r.actionable) return false;
      if (filtre === "A_DECIDER") return true;
      if (filtre === "RETARD") return r.deadline !== null && new Date(r.deadline).getTime() < now;
      return now - new Date(r.createdAt).getTime() >= DORMANT_MS;
    },
    [filtre, now],
  );

  const visibles = rows.filter(garde);

  // Par MODULE — l'ordre d'urgence est déjà celui des lignes ; on ne fait que les regrouper,
  // et le premier groupe est donc celui qui porte la demande la plus urgente.
  const groupes = React.useMemo(() => {
    const map = new Map<string, CentreRow[]>();
    for (const r of visibles) {
      const key = r.module || "Autres";
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [visibles]);

  const nombre: Record<Filtre, number> = {
    A_DECIDER: compte.aDecider,
    RETARD: compte.enRetard,
    DORMANTES: compte.dormantes,
    TOUT: rows.length,
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="Gavel"
        title="Aucune décision en attente"
        description="Les demandes de validation qui vous sont adressées, quel que soit le module d'où elles viennent, arrivent ici."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {FILTRES.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFiltre(f.id)}
            className={`min-h-9 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors sm:min-h-0 sm:py-1 ${
              filtre === f.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:bg-secondary"
            }`}
          >
            {f.label} ({nombre[f.id]})
          </button>
        ))}
      </div>

      {visibles.length === 0 ? (
        <EmptyState icon="CheckCheck" title="Rien dans ce filtre" description="Changez de filtre pour voir le reste." />
      ) : (
        groupes.map(([module, list]) => (
          <section key={module} className="surface space-y-3 p-3 sm:p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Gavel className="h-4 w-4 text-primary" /> {module}
              <span className="text-xs font-normal text-muted-foreground">({list.length})</span>
            </h2>
            <div className="space-y-3">
              {list.map((r) => <CentreCard key={r.stepId} r={r} now={now} />)}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/**
 * UNE DEMANDE, TOUT CE QU'IL FAUT POUR TRANCHER.
 *
 * Le lien vers la demande SOURCE compte autant que le panneau de décision : on valide une
 * dépense en regardant le bon de commande, pas son résumé en une ligne. Il n'apparaît que
 * lorsque le demandeur l'a renseigné — un lien mort vaut moins qu'aucun lien.
 */
function CentreCard({ r, now }: { r: CentreRow; now: number }) {
  const j = r.deadline ? daysUntil(r.deadline) : null;
  const enRetard = r.deadline !== null && new Date(r.deadline).getTime() < now;
  const dort = r.actionable && now - new Date(r.createdAt).getTime() >= DORMANT_MS;
  const avisMessage = r.itemDecisions.find((x) => x.itemKey === "MESSAGE");
  const nature = libelleNatureValidation(r.objectType);

  return (
    <Card className={enRetard ? "border-destructive/40" : undefined}>
      <CardContent className="flex flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{r.reference}</span>
            {/* La nature EN CLAIR — jamais la clé (« INFO_MED_DIRECTEUR_OPS », recette du 23/11). */}
            {nature && <Badge tone="neutral" dot={false}>{nature}</Badge>}
            <StatusBadge map={PRIORITY} value={r.priority} dot={false} />
            {r.amount !== null && <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{formatCurrency(r.amount)}</span>}
            {enRetard && (
              <Badge tone="danger" dot={false}>
                <AlarmClock className="mr-1 inline h-3 w-3" />
                En retard{j !== null ? ` de ${Math.abs(j)} j` : ""}
              </Badge>
            )}
            {!enRetard && dort && <Badge tone="warning" dot={false}>Sans décision depuis 7 j</Badge>}
          </div>

          <p className="font-medium [overflow-wrap:anywhere]">{r.title}</p>
          {r.description && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{r.description}</p>}

          <p className="text-xs text-muted-foreground">
            Demandé par {r.requester || "—"} · {formatDateTime(r.createdAt)}
            {r.deadline ? ` · échéance ${formatDate(r.deadline)}` : ""}
          </p>

          {/* LA DEMANDE SOURCE — le module d'où elle vient, avec son contexte complet. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link
              href={`/validations/${r.requestId}`}
              className="inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Ouvrir la demande
            </Link>
            {r.link && (
              <Link href={r.link} className="inline-flex min-h-9 items-center gap-1 text-xs text-primary hover:underline sm:min-h-0">
                <ExternalLink className="h-3.5 w-3.5" /> Ouvrir l&apos;objet concerné
              </Link>
            )}
          </div>

          {/* Un AVIS, dit facultatif : il ne remplace pas la décision (recette du 23/11). */}
          {r.actionable && <AvisSurLeMessage stepId={r.stepId} current={avisMessage?.decision} currentComment={avisMessage?.comment} />}

          {r.documents.length > 0 && (
            <div className="rounded-lg border border-border/60 bg-secondary/30 p-2">
              <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                Pièces à valider ({r.documents.length})
              </p>
              {r.actionable ? (
                <ValidationAttachments stepId={r.stepId} documents={r.documents} decisions={r.itemDecisions} />
              ) : (
                <DocumentList documents={r.documents} />
              )}
            </div>
          )}
        </div>

        <div className="w-full shrink-0 border-t border-border/60 pt-3 lg:w-auto lg:border-0 lg:pt-0">
          {r.actionable ? (
            <ValidationDecision stepId={r.stepId} />
          ) : (
            <Badge tone="warning" dot={false}>En attente du validateur précédent</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
