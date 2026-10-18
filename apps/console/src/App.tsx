import { Navigate, Route, Routes } from "react-router-dom";
import { Markets } from "./pages/Markets.tsx";
import { Login } from "./pages/Login.tsx";
import { ConsoleShell } from "./pages/ConsoleShell.tsx";
import { BorrowerView } from "./pages/BorrowerView.tsx";
import { LenderView } from "./pages/LenderView.tsx";
import { ExitView } from "./pages/ExitView.tsx";
import { RepoView } from "./pages/RepoView.tsx";

export default function App() {
  return (
    <Routes>
      <Route path="/markets" element={<Markets />} />
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ConsoleShell />}>
        <Route index element={<Navigate to="/borrower" replace />} />
        <Route path="borrower" element={<BorrowerView />} />
        <Route path="lender" element={<LenderView />} />
        <Route path="exit" element={<ExitView />} />
        <Route path="repo" element={<RepoView />} />
      </Route>
    </Routes>
  );
}
