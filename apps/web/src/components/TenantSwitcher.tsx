import { useState } from "react";
import { getTenantId, setTenantId } from "../api/client";
import { Input } from "./ui/input";

export function TenantSwitcher() {
  const [tenant, setTenant] = useState(getTenantId());
  return (
    <div className="border-t px-3 py-3 text-xs">
      <label className="text-zinc-500">租户 ID</label>
      <Input
        value={tenant}
        onChange={(e) => setTenant(e.target.value)}
        onBlur={() => setTenantId(tenant.trim() || getTenantId())}
        className="mt-1 font-mono text-xs"
      />
    </div>
  );
}