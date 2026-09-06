import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Header } from "./components/Header";
import { InstallHint } from "./components/InstallHint";
import { RequireAdmin, RequireAuth } from "./components/RequireAuth";
import Admin from "./pages/Admin";
import GamePicker from "./pages/GamePicker";
import LiarsBarTable from "./pages/LiarsBarTable";
import Lobby from "./pages/Lobby";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Table from "./pages/Table";

// Dispatches /table/:gameId/:tableId to the right game's table screen.
// doudizhu's Table.tsx is the only one wired to a real game engine so far;
// liarsbar gets a placeholder until its table screen lands.
function TableRoute() {
  const { gameId } = useParams<{ gameId: string }>();
  switch (gameId) {
    case "doudizhu":
      return <Table />;
    case "liarsbar":
      return <LiarsBarTable />;
    default:
      return <Navigate to="/" replace />;
  }
}

export default function App() {
  return (
    <>
      <Header />
      <InstallHint />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <GamePicker />
            </RequireAuth>
          }
        />
        <Route
          path="/lobby/:gameId"
          element={
            <RequireAuth>
              <Lobby />
            </RequireAuth>
          }
        />
        <Route
          path="/table/:gameId/:tableId"
          element={
            <RequireAuth>
              <TableRoute />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <Admin />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
