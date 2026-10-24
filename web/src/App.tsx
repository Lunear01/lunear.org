import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { Header } from "./components/Header";
import { InstallHint } from "./components/InstallHint";
import { RequireAdmin, RequireAuth } from "./components/RequireAuth";
import Admin from "./pages/Admin";
import BlackjackTable from "./pages/BlackjackTable";
import ChuDaiDTable from "./pages/ChuDaiDTable";
import GamePicker from "./pages/GamePicker";
import LiarsBarTable from "./pages/LiarsBarTable";
import PescaloTable from "./pages/PescaloTable";
import Lobby from "./pages/Lobby";
import Login from "./pages/Login";
import PokerTable from "./pages/PokerTable";
import Register from "./pages/Register";
import Shop from "./pages/Shop";
import Table from "./pages/Table";
import UnoTable from "./pages/UnoTable";

// Dispatches /table/:gameId/:tableId to the right game's table screen.
// Every registered game (doudizhu, liarsbar, poker, blackjack, chudaidi,
// uno, pescalo) is wired to a real game engine and table screen.
function TableRoute() {
  const { gameId } = useParams<{ gameId: string }>();
  switch (gameId) {
    case "doudizhu":
      return <Table />;
    case "liarsbar":
      return <LiarsBarTable />;
    case "poker":
      return <PokerTable />;
    case "blackjack":
      return <BlackjackTable />;
    case "chudaidi":
      return <ChuDaiDTable />;
    case "uno":
      return <UnoTable />;
    case "pescalo":
      return <PescaloTable />;
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
          path="/shop"
          element={
            <RequireAuth>
              <Shop />
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
