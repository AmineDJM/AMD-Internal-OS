import Link from "next/link";
import { KeyRound } from "lucide-react";
import type { UserRole } from "@prisma/client";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ADMIN_TABS, ROLE_LABELS } from "@/lib/labels";
import { chargerConsoleAccesIa } from "@/modules/assistant-ia/api";
import { ConsoleProactivite } from "@/modules/assistant-ia/ecrans/console-proactivite";
import { AccesAssistantIaForm, type LignePersonne, type LigneRole } from "./acces-form";

export const metadata = { title: "Assistant IA — accès — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * ASSISTANT IA — ACCÈS (décision 0012, Direction 29/10/2026) : ce que l'assistant peut faire pour chaque rôle et chaque
 * personne, par familles (salaires, budgets, contrats, fiches, Drive, réglementaire, Ad & Pro, écritures). Super Admin
 * seul. L'écran montre, pour chaque personne, l'accès EFFECTIF (droits applicatifs + réglage du rôle + le sien) — le
 * même calcul que le moteur fait à chaque tour (`accesAssistantIa`).
 */
export default async function AccesAssistantIaPage() {
  const user = await requireModule("ADMIN", "UPDATE");
  const tabs = <ModuleTabs tabs={ADMIN_TABS.map((t) => ({ label: t.label, href: t.href, show: userCan(user, t.module, "VIEW") }))} />;
  if (user.role !== "SUPER_ADMIN") {
    return (
      <div className="space-y-5">
        {tabs}
        <p className="text-sm text-muted-foreground">Les accès de l&apos;Assistant IA sont réglés par le Super Admin.</p>
      </div>
    );
  }

  const { parRole, personnes: comptes, plafondsGlobaux } = await chargerConsoleAccesIa();
  const roles: LigneRole[] = (Object.keys(ROLE_LABELS) as UserRole[])
    .filter((r) => r !== "SUPER_ADMIN")
    .map((r) => ({ role: r, libelle: ROLE_LABELS[r] ?? r, reglage: parRole.get(r) ?? { ouvertes: [], fermees: [] } }));
  const personnes: LignePersonne[] = comptes.map((c) => ({ ...c, role: ROLE_LABELS[c.role] ?? c.role }));

  return (
    <div className="space-y-5">
      {tabs}
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><KeyRound className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assistant IA — accès</h1>
          <p className="text-sm text-muted-foreground">
            Ce que l&apos;Assistant IA peut lire et préparer pour chacun. Le Super Admin a tout, toujours. Pour les autres, chaque famille
            suit par défaut les droits de la personne dans l&apos;application — sauf <strong>Salaires &amp; paie</strong> et{" "}
            <strong>Contrats &amp; documents RH</strong>, fermées tant que vous ne les ouvrez pas. Ouvrir une famille peut donner à
            l&apos;assistant plus que les droits de la personne : c&apos;est votre décision, et elle est journalisée.{" "}
            <Link href="/admin/ai" className="underline">Centre de contrôle IA</Link>
          </p>
        </div>
      </div>
      <AccesAssistantIaForm roles={roles} personnes={personnes} plafondsGlobaux={plafondsGlobaux} />
      <ConsoleProactivite />
    </div>
  );
}
