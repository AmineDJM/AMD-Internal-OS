"use client";

import * as React from "react";
import { Loader2, KeyRound, Check, ShieldAlert, ShieldCheck, LogOut, Compass } from "lucide-react";
import {
  adminResetPassword, requestOnboarding, revokeAllSessions, setUserActive, updateUserProfile,
} from "@/lib/actions/access-actions";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ROLE_LABELS } from "@/lib/labels";
import { formatDateTime } from "@/lib/utils";

interface Profile {
  id: string; name: string; email: string; title: string; region: string; role: string;
}

export function ProfileForm({ user }: { user: Profile }) {
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        setSaving(true); setError(null);
        try {
          const r = await updateUserProfile(fd);
          if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
          else setError(r.error ?? "Le profil n'a pas été enregistré.");
        } catch {
          setError(actionFailureMessage("THROWN"));
        } finally {
          setSaving(false);
        }
      }}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <input type="hidden" name="userId" value={user.id} />
      <div className="space-y-1"><Label htmlFor="name">Nom</Label><Input id="name" name="name" defaultValue={user.name} /></div>
      <div className="space-y-1"><Label htmlFor="role">Rôle (défaut)</Label>
        <Select id="role" name="role" defaultValue={user.role}>
          {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </div>
      <div className="sm:col-span-2 space-y-1">
        <Label htmlFor="email">E-mail (identifiant de connexion)</Label>
        <Input id="email" name="email" type="email" autoComplete="off" defaultValue={user.email} />
      </div>
      <div className="space-y-1"><Label htmlFor="title">Fonction</Label><Input id="title" name="title" defaultValue={user.title} /></div>
      <div className="space-y-1"><Label htmlFor="region">Région</Label><Input id="region" name="region" defaultValue={user.region} /></div>
      {error && <p className="sm:col-span-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="sm:col-span-2 flex justify-end">
        <Button type="submit" disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer le profil"}
        </Button>
      </div>
    </form>
  );
}

export function ResetPasswordForm({ userId }: { userId: string }) {
  const [pw, setPw] = React.useState("");
  const [done, setDone] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  function generate() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#";
    setPw(Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""));
  }

  return (
    <form
      action={async (fd) => {
        setSaving(true); setErr(null);
        try {
          const r = await adminResetPassword(fd);
          if (r.ok) setDone(true);
          else setErr(r.error ?? "Le mot de passe n'a pas été réinitialisé.");
        } catch {
          setErr(actionFailureMessage("THROWN"));
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-2"
    >
      <input type="hidden" name="userId" value={userId} />
      <Label htmlFor="password">Nouveau mot de passe</Label>
      <div className="flex gap-2">
        <Input id="password" name="password" autoComplete="new-password" className="min-w-0" value={pw} onChange={(e) => { setPw(e.target.value); setDone(false); }} placeholder="min. 8 caractères" />
        <Button type="button" variant="outline" onClick={generate}>Générer</Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="mustChange" defaultChecked className="h-4 w-4 rounded border-input" />
        Forcer le changement à la prochaine connexion
      </label>
      <Button type="submit" variant="destructive" disabled={saving || pw.length < 8}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        Réinitialiser
      </Button>
      <Retour ton="erreur">{err}</Retour>
      {done && (
        <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
          Mot de passe défini. Communiquez-le à l’utilisateur&nbsp;: <code className="font-mono [overflow-wrap:anywhere]">{pw}</code>
          <br />Toutes ses sessions ont été révoquées.
        </p>
      )}
    </form>
  );
}

export function ActiveToggle({ userId, isActive, isSelf }: { userId: string; isActive: boolean; isSelf: boolean }) {
  return (
    <form action={async (fd) => { await setUserActive(fd); }}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="active" value={(!isActive).toString()} />
      <Button type="submit" variant={isActive ? "outline" : "success"} disabled={isSelf} title={isSelf ? "Vous ne pouvez pas vous désactiver" : ""}>
        {isActive ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
        {isActive ? "Désactiver le compte" : "Activer le compte"}
      </Button>
    </form>
  );
}

export function RevokeAllButton({ userId }: { userId: string }) {
  return (
    <form action={async (fd) => { await revokeAllSessions(fd); }}>
      <input type="hidden" name="userId" value={userId} />
      <Button type="submit" variant="outline" size="sm">
        <LogOut className="h-4 w-4" /> Déconnecter partout
      </Button>
    </form>
  );
}

export function RequestOnboardingButton({
  userId, mustOnboard, onboardedAt,
}: {
  userId: string;
  mustOnboard: boolean;
  onboardedAt: string | null;
}) {
  const [saving, setSaving] = React.useState(false);
  const [requested, setRequested] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const pending = mustOnboard || requested;
  return (
    <div className="space-y-1.5">
      <form
        action={async (fd) => {
          setSaving(true); setErr(null);
          try {
            const r = await requestOnboarding(fd);
            if (r.ok) setRequested(true);
            else setErr(r.error ?? "Le setup n'a pas été demandé.");
          } catch {
            setErr(actionFailureMessage("THROWN"));
          } finally {
            setSaving(false);
          }
        }}
      >
        <input type="hidden" name="userId" value={userId} />
        <Button type="submit" variant="outline" size="sm" disabled={saving || pending}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Compass className="h-4 w-4" />}
          {pending ? "Setup demandé" : "Demander le setup"}
        </Button>
      </form>
      <Retour ton="erreur">{err}</Retour>
      <p className="text-xs text-muted-foreground">
        {pending
          ? "L’utilisateur sera guidé à sa prochaine navigation."
          : onboardedAt
            ? `Onboarding terminé le ${formatDateTime(onboardedAt)}.`
            : "Relance le parcours de configuration guidé."}
      </p>
    </div>
  );
}
