"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Loader2, CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Label } from "@/components/ui/input";
import { ROLE_LABELS } from "@/lib/labels";
import { setDepartmentBudgetAccess } from "@/lib/actions/department-budget-actions";
import { DEPT_BUDGET_LABEL, type DeptBudgetGrant } from "@/lib/department-budget";

/**
 * Rôles auxquels on peut ouvrir un budget départemental — DÉRIVÉS des rôles réels plutôt que
 * recopiés. Une liste écrite à la main finit par proposer un rôle qui n'existe plus (ou par
 * oublier celui qu'on vient d'ajouter), et une case cochée sur un rôle fantôme n'autorise
 * personne — sans que rien ne le signale.
 *
 * Deux exclusions : le Super Admin a déjà tout, et le Lecteur ne règle rien par définition.
 */
const ROLE_OPTIONS = Object.keys(ROLE_LABELS).filter((r) => r !== "SUPER_ADMIN" && r !== "VIEWER");

type UserOpt = { id: string; name: string };

/**
 * RÉGLAGE DES ACCÈS — Super Admin uniquement.
 *
 * Trois blocs, dans l'ordre où la question se pose : qui **voit**, qui **édite le
 * fonctionnement**, qui **édite les employés**. Ce sont trois populations différentes, et les
 * confondre serait précisément l'erreur que la séparation des deux budgets cherche à éviter.
 *
 * L'écran dit ce qu'il fait — « ces autorisations s'AJOUTENT » — parce qu'un formulaire
 * d'autorisations qu'on croit restrictif alors qu'il est additif se découvre trop tard.
 */
export function DepartmentAccessSheet({
  open, onClose, departmentId, departmentLabel, grant, users,
}: {
  open: boolean;
  onClose: () => void;
  /** `null` = la règle GÉNÉRALE (tous les départements). */
  departmentId: string | null;
  departmentLabel: string;
  grant: DeptBudgetGrant;
  users: UserOpt[];
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    const fd = new FormData(e.currentTarget);
    fd.set("departmentId", departmentId ?? "__GENERAL__");
    void (async () => {
      try {
        const r = await setDepartmentBudgetAccess(fd);
        setMsg({ ok: r.ok, text: r.ok ? "Accès enregistrés." : (r.error ?? "Les accès n'ont pas été enregistrés.") });
        if (r.ok) { onClose(); rafraichir(); }
      } catch {
        setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      } finally {
        setBusy(false);
        lock.current = false;
      }
    })();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={departmentId ? `Accès — ${departmentLabel}` : "Accès — règle générale"}
      description={
        departmentId
          ? "Ces autorisations ne valent que pour ce département. Elles s'ajoutent à la règle générale et aux droits par rôle."
          : "Cette règle vaut pour TOUS les départements. Elle s'ajoute aux droits par rôle ; chaque département peut ensuite ouvrir davantage."
      }
      width="md"
    >
      <form onSubmit={submit} className="space-y-5">
        <p className="flex items-start gap-2 rounded-xl border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Ces autorisations <strong>s&apos;ajoutent</strong> : elles ouvrent l&apos;accès à des personnes en plus.
            Elles ne retirent rien — le gestionnaire de budget garde le fonctionnement, les ressources humaines
            gardent les employés. Pour retirer un accès, c&apos;est le <strong>droit de module</strong> qu&apos;il faut
            revoir.
          </span>
        </p>

        <Block
          title="Consultation"
          hint="Voir le budget de ce département, sans pouvoir le modifier."
          roleName="accessRoles" userName="accessUserIds"
          roles={grant.accessRoles} userIds={grant.accessUserIds} users={users}
        />
        <Block
          title={`Édition — ${DEPT_BUDGET_LABEL.OPERATING}`}
          hint="Régler les moyens généraux (fournitures, prestations, déplacements). Le DIRECTEUR du département les tient déjà d'office : cette liste sert à ouvrir à quelqu'un d'autre."
          roleName="operatingRoles" userName="operatingUserIds"
          roles={grant.operatingRoles} userIds={grant.operatingUserIds} users={users}
        />
        <Block
          title={`Édition — ${DEPT_BUDGET_LABEL.HR}`}
          hint="Régler la masse salariale et le budget de recrutement."
          roleName="hrRoles" userName="hrUserIds"
          roles={grant.hrRoles} userIds={grant.hrUserIds} users={users}
        />
        <Block
          title={`Édition — ${DEPT_BUDGET_LABEL.ACTIVITY}`}
          hint="Régler le budget métier du département (Ad & Pro au marketing, paiement des BV au Regulatory…). Listes SÉPARÉES des moyens généraux : ouvrir l'un n'ouvre pas l'autre."
          roleName="activityRoles" userName="activityUserIds"
          roles={grant.activityRoles} userIds={grant.activityUserIds} users={users}
        />

        {msg && (
          <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
            {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            {msg.text}
          </p>
        )}

        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Enregistrer
          </Button>
          <Button size="sm" type="button" variant="outline" onClick={onClose}>Annuler</Button>
        </div>
      </form>
    </Sheet>
  );
}

function Block({
  title, hint, roleName, userName, roles, userIds, users,
}: {
  title: string; hint: string; roleName: string; userName: string;
  roles: string[]; userIds: string[]; users: UserOpt[];
}) {
  return (
    <fieldset className="space-y-2 rounded-xl border border-input p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <p className="text-xs text-muted-foreground">{hint}</p>

      <Label className="text-xs font-normal text-muted-foreground">Par rôle</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {ROLE_OPTIONS.map((r) => (
          <label key={r} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name={roleName} value={r} defaultChecked={roles.includes(r)} className="h-4 w-4 rounded border-input" />
            {ROLE_LABELS[r] ?? r}
          </label>
        ))}
      </div>

      {users.length > 0 && (
        <>
          <Label className="text-xs font-normal text-muted-foreground">Personnes précises</Label>
          <div className="grid max-h-36 grid-cols-1 gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-input p-2 sm:grid-cols-2">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name={userName} value={u.id} defaultChecked={userIds.includes(u.id)} className="h-4 w-4 rounded border-input" />
                {u.name}
              </label>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}
