import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { hasGlobalView, peutPiloterMissionsAdam, peutUtiliserAssistantIA } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { centreDeMissions, vueGlobaleDesMissions } from "@/lib/missions/view/control";
import { mesMissions } from "@/modules/assistant-ia/api";
import { ListeMissionsAdam } from "@/modules/assistant-ia/ecrans/missions/liste-missions-adam";
import { VueGlobaleMissions } from "@/components/missions/mission-control-list";
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
  const user = await requireUser();
  // OUVERT À QUI A ADAM (Direction, 02/11/2026 : « tout le monde verra les missions d'Adam, chacun selon les missions
  // qu'il lui a données »). Sans Adam, la page n'existe pas — même réponse qu'une adresse inconnue.
  //
  // CE QUE CHACUN LIT : SES missions, et elles seules — chaque lecture ci-dessous est filtrée par SON identifiant
  // (`centreDeMissions`, `mesMissions`, par `user.id`). CE QUI RESTE AU SUPER ADMIN (`peutPiloterMissionsAdam`,
  // §118.136) : la vue globale, l'interrupteur général, les accords et les gestes de masse — non chargés pour les autres.
  const superAdmin = peutPiloterMissionsAdam(user);
  if (!superAdmin && !peutUtiliserAssistantIA(user)) notFound();
  const maintenant = new Date();

  const [centre, mes, interrupteur] = await Promise.all([
    centreDeMissions(user.id),
    mesMissions(user.id, { toutes: true, maintenant }).catch(sansBloquer("centre-de-missions-page.CentreDeMissionsPage.mesMissions", null)),
    // L'INTERRUPTEUR GLOBAL (§118.132) : s'il est posé, l'écran doit le dire AVANT les
    // compteurs — sinon « 3 en cours » se lit comme trois missions qui avancent.
    lireInterrupteurMissions(),
  ]);
  const [accords, masse, globale] = superAdmin
    ? await Promise.all([
        listerAccordsMission(),
        // Les nombres des boutons de masse viennent du MÊME prédicat que les gestes (§118.51).
        compterPourLesGestesDeMasse(user.id),
        vueGlobaleDesMissions(),
      ])
    : [[], null, null] as const;
  const poseur = interrupteur.parId
    ? await prisma.user.findUnique({ where: { id: interrupteur.parId }, select: { name: true } }).catch(sansBloquer("centre-de-missions-page.CentreDeMissionsPage.user", null))
    : null;
  const executionVisible = superAdmin || centre.vivantes.length + centre.closes.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Missions d'Adam"
        description={superAdmin
          ? "Tout ce qu'Adam exécute pour vous : ce qui attend une décision de votre part en premier, puis ce qui est bloqué, puis ce qui avance — et, plus bas, la vue globale de toutes les personnes. Une mission longue s'y lit en JALONS."
          : "Les missions que vous avez confiées à Adam, avec leur état réel. Vous pouvez les mettre en pause, les reprendre ou les arrêter."}
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

      {/* ── MES MISSIONS — à tout le monde : les travaux confiés à Adam, et leurs gestes permis. */}
      <section className="space-y-2" aria-labelledby="mes-missions-titre">
        <h2 id="mes-missions-titre" className="text-sm font-semibold text-foreground">Mes missions</h2>
        {superAdmin && mes?.alerte ? (
          <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{mes.alerte}</p>
        ) : null}
        {mes ? <ListeMissionsAdam missions={mes.missions} /> : (
          <p className="text-sm text-slate-500">Vos missions n&apos;ont pas pu être lues — réessayez dans un instant.</p>
        )}
      </section>

      {superAdmin ? (
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
      ) : null}

      {/* ── LES GESTES DE MASSE (§118.132) — le confort du bouton, sur le même prédicat que le geste. Super Admin seul. */}
      {masse ? <MissionBulkControls suspendables={masse.suspendables} bloquees={masse.bloquees} /> : null}

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

      {executionVisible ? (
      <>
      <h2 className="text-sm font-semibold text-foreground">Missions d&apos;exécution</h2>
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
      </>
      ) : null}

      {/* ── LA VUE GLOBALE — le Super Admin seul : toutes les personnes, avec le propriétaire de chaque mission. */}
      {globale ? <VueGlobaleMissions vue={globale} maintenant={maintenant} moi={user.id} /> : null}
    </div>
  );
}
