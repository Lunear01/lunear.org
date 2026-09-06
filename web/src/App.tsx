import { Navigate, Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { InstallHint } from "./components/InstallHint";
import { RequireAdmin, RequireAuth } from "./components/RequireAuth";
import Admin from "./pages/Admin";
import GamePicker from "./pages/GamePicker";
import Lobby from "./pages/Lobby";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Table from "./pages/Table";

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
          path="/table/:tableId"
          element={
            <RequireAuth>
              <Table />
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
