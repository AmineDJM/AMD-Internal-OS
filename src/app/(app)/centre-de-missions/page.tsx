import Link from "next/link";
import { notFound } from "next/navigation";
import { requireModule } from "@/lib/session";
import { hasGlobalView, peutPiloterMissionsAdam } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { centreDeMissions } from "@/lib/missions/view/control";
import { compterPourLesGestesDeMasse } from "@/lib/missions/runtime/control";
import { ECRAN_REGLAGES_ADAM, lireInterrupteurMissions } from "@/lib/interrupteurs/missions";
import { listerAccordsMission } from "@/lib/actions/mission-runtime-actions";
import { depuis } from "@/lib/missions/view/duree";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { MissionControlList, MissionsCloses } from "@/components/missions/mission-control-list";
import { AccordControls, MissionBulkControls } from "@/components/missions/mission-runtime-controls";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Missions d'Adam — AMD Internal OS" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE MISSIONS — l'écran qui manquait.
 *
 * ── LE TROU, DIT SANS ENJOLIVER ─────────────────────────────────────────────────────────
 *
 * Une mission d'exécution avait une adresse (`/missions/<id>`, où pointent ses notifications)
 * et AUCUNE liste. `/missions` est le module RH — ordres de mission, congrès, accompagnants :
 * le lien « Toutes les missions » de la page de détail menait à un écran qui ne contiendrait
 * jamais la mission qu'on venait de quitter. Quelqu'un qui en lançait trois ne pouvait les voir
 * ensemble nulle part, et `listerAccordsMission` — écrite POUR un écran — n'avait aucun
 * appelant de production : on ne pouvait donner un accord qu'en arrivant par le lien d'une
 * notification, une mission à la fois (§118.14).
 *
 * ── CE QUE CET ÉCRAN FAIT, ET CE QU'IL NE FAIT PAS ──────────────────────────────────────
 *
 * Il montre le PARC et il porte les décisions qui bloquent : accorder, refuser. Il ne montre
 * pas le détail d'une mission — c'est la page de la mission qui l'a, et la dupliquer ici ferait
 * deux écrans qui divergeraient. Chaque ligne est un lien vers son adresse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function CentreDeMissionsPage() {
  const user = await requireModule("WORKSPACE");
  // RÉSERVÉ AU SUPER ADMIN (décision de la Direction, 09/2026 — `peutPiloterMissionsAdam`). Le
  // menu n'envoie pas l'entrée aux autres ; une adresse tapée à la main rend la même page qu'une
  // adresse inexistante : on ne dit pas « il y a un parc, mais pas pour vous ».
  if (!peutPiloterMissionsAdam(user)) notFound();
  const maintenant = new Date();

  const [centre, accords, interrupteur, masse] = await Promise.all([
    centreDeMissions(user.id),
    listerAccordsMission(),
    // L'INTERRUPTEUR GLOBAL (§118.132) : s'il est posé, l'écran doit le dire AVANT les
    // compteurs — sinon « 3 en cours » se lit comme trois missions qui avancent.
    lireInterrupteurMissions(),
    // Les nombres des boutons de masse viennent du MÊME prédicat que les gestes (§118.51).
    compterPourLesGestesDeMasse(user.id),
  ]);
  const poseur = interrupteur.parId
    ? await prisma.user.findUnique({ where: { id: interrupteur.parId }, select: { name: true } }).catch(sansBloquer("centre-de-missions-page.CentreDeMissionsPage.user", null))
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Missions d'Adam"
        description="Tout ce qu'Adam exécute pour vous : ce qui attend une décision de votre part en premier, puis ce qui est bloqué, puis ce qui avance. Une mission longue s'y lit en JALONS — pas en étapes du sous-plan en cours, qui ne diraient qu'un septième de l'histoire."
      />

      {interrupteur.suspendues ? (
        <section
          role="status"
          data-testid="centre-suspension"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <p className="font-medium">
            Toutes les missions d&apos;Adam sont suspendues
            {interrupteur.depuis ? ` — ${depuis(interrupteur.depuis.toISOString(), maintenant)}` : ""}
            {poseur?.name ? `, par ${poseur.name}` : ""}.
          </p>
          <p className="mt-1 text-amber-800">
            Rien n&apos;avance, rien ne se replanifie, rien ne notifie. Chaque mission repartira où elle en
            était à la levée
            {hasGlobalView(user) ? (
              <>
                {" — "}
                <Link href={ECRAN_REGLAGES_ADAM} className="font-medium underline">Réglages d&apos;Adam</Link>
              </>
            ) : " (par la direction, depuis les Réglages d'Adam)"}
            .
          </p>
        </section>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="En attente de vous" value={centre.compteurs.attendentVous} icon="TriangleAlert"
          tone={centre.compteurs.attendentVous > 0 ? "warning" : "default"}
          hint={centre.compteurs.attendentVous > 0 ? "C'est ce qui bloque Adam" : undefined}
        />
        <KpiCard
          label="Bloquées" value={centre.compteurs.bloquees} icon="OctagonAlert"
          tone={centre.compteurs.bloquees > 0 ? "danger" : "default"}
          hint="Plus rien n'avance tout seul"
        />
        <KpiCard label="En cours" value={centre.compteurs.vivantes} icon="Activity" tone="info" />
        <KpiCard
          label="Suspendues" value={centre.compteurs.enPause} icon="Pause"
          hint="Elles ne consomment rien"
        />
      </div>

      {/* ── LES GESTES DE MASSE (§118.132) — le confort du bouton, sur le même prédicat que le geste. */}
      <MissionBulkControls suspendables={masse.suspendables} bloquees={masse.bloquees} />

      {/* ── LES ACCORDS, DÉCIDABLES ICI ────────────────────────────────────────────────
          L'accord est une ATTESTATION : il exige une vraie session humaine (§118.15), donc il
          vit dans un écran et jamais dans un outil de modèle. Le mettre EN TÊTE du centre, et
          pas seulement sur la page de chaque mission, est ce qui évite de découvrir une
          autorisation attendue depuis six jours en cherchant autre chose. */}
      {accords.length > 0 ? (
        <section className="space-y-2" data-testid="centre-accords">
          <h2 className="text-sm font-semibold text-foreground">
            {accords.length} accord(s) attendent votre décision
          </h2>
          {accords.map((a) => (
            <div key={a.id} className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="flex flex-wrap items-baseline gap-2 text-sm">
                <Link href={`/missions/${a.missionId}`} className="min-w-0 break-words font-medium text-amber-900 hover:underline">
                  {a.missionTitle}
                </Link>
                <span className="text-xs text-amber-800">
                  {a.niveau === "CRITICAL" ? "décision critique"
                    : a.niveau === "SENSITIVE" ? "décision sensible" : "décision"}
                  {" · "}{depuis(a.depuis, maintenant)}
                </span>
              </p>
              <div className="mt-2">
                <AccordControls approvalId={a.id} resume={a.summary} />
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <MissionControlList
        lignes={centre.vivantes}
        maintenant={maintenant}
        vide={
          <EmptyState
            icon="Sparkles"
            title="Aucune mission en cours"
            description="Demandez quelque chose à Adam qui demande plusieurs actions — collecter auprès de trois personnes, préparer un dossier, surveiller une échéance — et la mission apparaîtra ici avec son avancement réel."
          />
        }
      />

      <MissionsCloses lignes={centre.closes} maintenant={maintenant} />
    </div>
  );
}
