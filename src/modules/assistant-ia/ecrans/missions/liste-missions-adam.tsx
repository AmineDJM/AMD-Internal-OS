"use client";

import Link from "next/link";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { ArrowRight, Pause, Play, Square } from "lucide-react";
import type { MissionLue } from "@/modules/assistant-ia/api";
import { gestesPermis } from "../../domaine/sous-missions";
import { useGestesMission } from "./tableau-missions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MISSIONS D'ADAM » — LES MIENNES (Direction, 02/11/2026 : « tout le monde verra les missions d'Adam, chacun selon
 * les missions qu'il lui a données »).
 *
 * Les missions que la personne a confiées à Adam (`Mission.ownerId` = elle), avec leur état HONNÊTE — le libellé et le
 * diagnostic du moteur, jamais recomposés ici — et les gestes que SES droits permettent : pause, reprise, arrêt, par
 * les actions du module (cloisonnées par la personne dans chaque `where`). Un bouton n'apparaît que si l'état
 * l'autorise (`gestesPermis`, la règle du tableau de l'assistant) : un bouton qui ne peut rien faire n'est pas montré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function ListeMissionsAdam({ missions }: { missions: MissionLue[] }) {
  const { rafraichir } = useRafraichir();
  const gestes = useGestesMission(async () => rafraichir());
  const bouton = "inline-flex h-11 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:h-8";

  if (missions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500" data-testid="mes-missions-adam-vide">
        Aucune mission confiée à Adam pour l&apos;instant. Demandez-lui un travail long — une recherche, un dossier à
        préparer, plusieurs personnes à relancer — et il apparaîtra ici avec son avancement réel.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="mes-missions-adam">
      {gestes.avis ? <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">{gestes.avis}</p> : null}
      <ul className="space-y-2">
        {missions.map((m) => {
          const permis = gestesPermis(m.etat);
          return (
            <li key={m.id} className="rounded-lg border border-slate-200 bg-white p-3" data-testid="mission-adam" data-mission={m.id} data-etat={m.etat}>
              <div className="flex flex-wrap items-baseline gap-2">
                <Link href={`/missions/${m.id}`} className="min-w-0 break-words font-medium text-slate-900 hover:underline">{m.titre}</Link>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{m.libelle}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {/* Un plan pas encore approuvé n'a pas d'étapes : « 0/0 » ne dirait rien — l'état le dit déjà. */}
                {m.etapes.total > 0 ? `${m.etapes.faites}/${m.etapes.total} étape(s)${m.etapes.enEchec ? ` · ${m.etapes.enEchec} en échec` : ""} · ` : ""}
                mise à jour le {new Date(m.majLe).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Africa/Algiers" })}
              </p>
              {m.diagnostic.phrase ? <p className="mt-1 text-sm text-slate-700">{m.diagnostic.phrase}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {permis.pause ? (
                  <button type="button" className={bouton} disabled={gestes.occupe !== null} onClick={() => gestes.pauser(m.id)}>
                    <Pause className="h-4 w-4" aria-hidden /> Mettre en pause
                  </button>
                ) : null}
                {permis.reprise ? (
                  <button type="button" className={bouton} disabled={gestes.occupe !== null} onClick={() => gestes.reprendre(m.id)}>
                    <Play className="h-4 w-4" aria-hidden /> Reprendre
                  </button>
                ) : null}
                {permis.annuler ? (
                  <button type="button" className={bouton} disabled={gestes.occupe !== null} onClick={() => gestes.annuler(m.id)}>
                    <Square className="h-4 w-4" aria-hidden /> Arrêter
                  </button>
                ) : null}
                <Link href={`/missions/${m.id}`} className={`${bouton} ml-auto`}>
                  Détail <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
