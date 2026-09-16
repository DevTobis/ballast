import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./lib/auth.tsx";
import { Login } from "./pages/Login.tsx";
import { ConsoleShell } from "./pages/ConsoleShell.tsx";
import { BorrowerView } from "./pages/BorrowerView.tsx";
import { LenderView } from "./pages/LenderView.tsx";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ConsoleShell />}>
          <Route index element={<Navigate to="/borrower" replace />} />
          <Route path="borrower" element={<BorrowerView />} />
          <Route path="lender" element={<LenderView />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
