import { redirect } from "next/navigation";

export default function ApprovalsPage() {
  redirect("/jobs?view=pending");
}
