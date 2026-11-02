import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { EnablePushButton } from "@/components/layout/push-activer";
import { NotificationsList, type NotificationItem } from "./notifications-list";

export default async function NotificationsPage() {
  const user = await requireModule("NOTIFICATIONS");

  const notifications = await prisma.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const items: NotificationItem[] = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    isRead: n.isRead,
    createdAt: n.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-5">
      <PageHeader title="Notifications" description="Échéances, validations, retards et assignations qui vous concernent.">
        <EnablePushButton />
      </PageHeader>
      <NotificationsList items={items} />
    </div>
  );
}
