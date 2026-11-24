import Link from "next/link";
import { requireModule } from "@/lib/session";
import { discussionsDesConges, getMyLeaveBalance } from "@/modules/rh/api";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ongletsEspace } from "@/lib/queries/mes-taches";
import { trierConges } from "@/lib/queries/mes-decisions";
import { chargerAujourdhui } from "@/lib/queries/aujourdhui-espace";
import { grouperAFaire } from "@/lib/espace/a-faire";
import { listerMesRappels } from "@/lib/queries/reminders";
import { TrainingRequestButton } from "@/components/purchase/training-request-button";
import { ExpenseClaimButton } from "@/components/hr/expense-claim-button";
import { getManagerOfUser } from "@/lib/departments";
import { CHEMIN_TACHES } from "@/lib/chemins/espace";
import { FileAFaire } from "./file-a-faire";
import { RappelsDuJour } from "./rappels-du-jour";
import { RenvoiAncres } from "./renvoi-ancres";
import { sansBloquer } from "@/lib/journal";

/**
 * « AUJOURD'HUI » — L'ONGLET PRINCIPAL DE L'ESPACE (Direction, 14/10/2026), SIMPLIFIÉ (maquette validée par le
 * Super Admin, 24/11/2026 : « on change uniquement l'interface, on la simplifie ; tout ce qui est déjà implémenté
 * reste pareil »).
 *
 * Même adresse (`/mon-espace` : liens, notifications et l'ancre `#conges-a-signer` y pointent). Un bonjour et la
 * date ; trois onglets ; « À faire · N » en trois groupes (`espace/a-faire.ts`) où chaque congé à signer est une
 * ligne qui ouvre son panneau de décision ; à droite « Mes rappels », « Demander » et, pour un N+1, « Mon équipe ».
 *
 * CE QUI A QUITTÉ L'ÉCRAN ET OÙ LE TROUVER : les avances sur salaire et « Ma gamme et mes produits » → Mon dossier
 * RH ; « Mon bilan » → un lien de Mon dossier RH ; « Missions terrain » → un lien sous la file (ses lignes y sont) ;
 * les pièces que J'attends → une ligne de « Plus tard » ; la relance d'une tâche demandée → Tâches › Demandées ;
 * les raccourcis du métier → le menu de chaque module. La phrase d'accroche, la ligne « semaine » et les tuiles de
 * chiffres disparaissent, avec les lectures qui ne servaient qu'à elles.
 *
 * Tout vient des lectures existantes, déjà gardées par les droits (`getActionCenter` et consorts —
 * `queries/aujourdhui-espace.ts`) : aucune donnée simulée, aucun chiffre sans source.
 */
export default async function MonEspacePage() {
  const user = await requireModule("WORKSPACE");
  const maintenant = new Date();
  const [jour, rappels, manager, solde, onglets] = await Promise.all([
    chargerAujourdhui(user, { maintenant }),
    // TOUS LES RAPPELS (recette du 23/11/2026) : les siens, ceux de l'assistant ; l'encart n'en montre que les actifs.
    listerMesRappels(user.id),
    // Le responsable hiérarchique — nommé dans le formulaire de formation : il ne se choisit pas.
    getManagerOfUser(user.id).catch(sansBloquer("mon-espace-page.MonEspacePage.getManagerOfUser", null)),
    getMyLeaveBalance(user.id).catch(sansBloquer("mon-espace-page.MonEspacePage.getMyLeaveBalance", null)),
    ongletsEspace(user),
  ]);
  // LES CONGÉS À SIGNER : la MÊME lecture que les lignes de la file (le centre) — le panneau de décision les reprend.
  const congesASigner = trierConges(jour.conges);
  const discussionsConges = await discussionsDesConges(congesASigner.map((c) => c.id));
  const aFaire = grouperAFaire(jour.lots, { piecesEnAttente: jour.piecesEnAttente });

  const dateDuJour = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Algiers" }).format(maintenant);
  const equipe = jour.equipe && jour.equipe.directs > 0 ? jour.equipe : null;
  const aRelancer = equipe ? equipe.membres.filter((m) => m.relanceTacheId).length : 0;

  return (
    <div className="space-y-6">
      <RenvoiAncres />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="break-words text-2xl font-bold tracking-tight">Bonjour {user.name.split(" ")[0]}</h1>
          <p className="text-sm text-muted-foreground first-letter:uppercase">{dateDuJour}</p>
        </div>
        <ModuleTabs tabs={onglets} />
      </header>

      {/* Au téléphone (< lg) : la file d'abord, puis rappels, demander, équipe — l'ordre du document. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <FileAFaire
          aFaire={aFaire}
          conges={congesASigner.map((c) => ({ ...c, commentaires: discussionsConges[c.id] ?? [] }))}
          maintenant={maintenant.toISOString()} currentUserId={user.id}
        />

        <aside className="flex min-w-0 flex-col gap-4">
          <Panneau id="rappels-titre" titre="Mes rappels">
            <RappelsDuJour rappels={rappels} maintenant={maintenant.toISOString()} />
          </Panneau>

          {/* DEMANDER — les mêmes destinations que l'ancien bloc « Moi » : le congé se demande depuis le dossier RH. */}
          <Panneau id="demander-titre" titre="Demander">
            <div className="flex flex-wrap gap-2">
              <Link href="/mon-dossier" className="inline-flex h-10 items-center rounded-[var(--radius)] border border-border bg-card px-4 text-sm font-medium hover:bg-secondary focus-ring">
                Un congé
              </Link>
              <ExpenseClaimButton libelle="Une note de frais" />
              <TrainingRequestButton managerName={manager?.fullName ?? null} libelle="Une formation" />
            </div>
            {solde !== null && <p className="mt-2.5 text-xs text-muted-foreground">Solde de congé : {solde} j</p>}
          </Panneau>

          {equipe && (
            <section aria-labelledby="equipe-titre" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
              <div className="min-w-0">
                <h2 id="equipe-titre" className="text-[15px] font-semibold">Mon équipe</h2>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {equipe.personnesEnRetard > 0
                    ? `${equipe.personnesEnRetard} ${equipe.personnesEnRetard > 1 ? "personnes ont" : "personne a"} du retard`
                    : "Personne n'a de tâche en retard"}
                  {/* La relance d'une tâche que vous avez demandée se fait dans Tâches › Demandées (même action, même règle). */}
                  {aRelancer > 0 && (
                    <> · <Link href={`${CHEMIN_TACHES}?vue=demandees`} className="text-primary hover:underline">relancer</Link></>
                  )}
                </p>
              </div>
              <Link href="/mon-equipe" className="inline-flex min-h-10 shrink-0 items-center text-sm font-semibold text-primary hover:underline">Voir</Link>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Panneau({ id, titre, children }: { id: string; titre: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-xl border border-border bg-card px-5 py-4 shadow-sm">
      <h2 id={id} className="mb-3.5 text-[17px] font-semibold">{titre}</h2>
      {children}
    </section>
  );
}
