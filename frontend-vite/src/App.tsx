import { BrowserRouter, Routes, Route } from "react-router-dom";
import './App.css'
import { ProtectedRoute } from "./routes/ProtectedRoute/ProtectedRoute";
import LoginPage from "./components/LoginPage/LoginPage";
import AdminDashboard from "./components/AdminDashboard/AdminDashboard";
import ModelRecordsPage from "./components/ModelRecordsPage/ModelRecordsPage";

function App() {

  return (
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AdminDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/models/:modelName"
            element={
              <ProtectedRoute>
                <ModelRecordsPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
  )
}

export default App
