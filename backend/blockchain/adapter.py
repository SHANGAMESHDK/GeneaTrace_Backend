import json
import os
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional
from web3 import Web3
from backend.app.core.config import settings
from backend.app.core.logging import logger


class BlockchainAdapterBase(ABC):
    @property
    @abstractmethod
    def is_mock(self) -> bool:
        pass

    @abstractmethod
    def check_connection(self) -> Dict[str, Any]:
        pass

    @abstractmethod
    def record_checkpoint(self, merkle_root: str, batch_id: str, event_count: int) -> Dict[str, Any]:
        pass

    @abstractmethod
    def verify_checkpoint(self, merkle_root: str) -> Dict[str, Any]:
        pass

    @abstractmethod
    def register_identity(self, commitment: str, entity_id: str) -> Dict[str, Any]:
        pass

    @abstractmethod
    def verify_identity(self, commitment: str) -> Dict[str, Any]:
        pass


class Web3BlockchainAdapter(BlockchainAdapterBase):
    def __init__(self):
        self._w3 = Web3(Web3.HTTPProvider(settings.BLOCKCHAIN_RPC_URL)) if settings.BLOCKCHAIN_RPC_URL else None
        self._contract = None
        self._load_contract()

    @property
    def is_mock(self) -> bool:
        return False

    def _load_contract(self):
        if not self._w3 or not settings.BLOCKCHAIN_CONTRACT_ADDRESS:
            return
        abi_path = os.path.join(os.path.dirname(__file__), "contracts", "GeneaTraceRegistry.json")
        if os.path.exists(abi_path):
            with open(abi_path, "r", encoding="utf-8") as f:
                abi = json.load(f)
            self._contract = self._w3.eth.contract(
                address=Web3.to_checksum_address(settings.BLOCKCHAIN_CONTRACT_ADDRESS),
                abi=abi,
            )

    def check_connection(self) -> Dict[str, Any]:
        if not self._w3:
            return {"status": "unhealthy", "is_mock": False, "connected": False, "error": "No RPC URL configured"}
        try:
            connected = self._w3.is_connected()
            block_number = self._w3.eth.block_number if connected else None
            return {
                "status": "healthy" if connected else "unhealthy",
                "is_mock": False,
                "connected": connected,
                "chain_id": settings.BLOCKCHAIN_CHAIN_ID,
                "latest_block": block_number,
                "contract_configured": self._contract is not None,
            }
        except Exception as e:
            return {"status": "unhealthy", "is_mock": False, "connected": False, "error": str(e)}

    def record_checkpoint(self, merkle_root: str, batch_id: str, event_count: int) -> Dict[str, Any]:
        if not self._contract or not settings.BLOCKCHAIN_PRIVATE_KEY:
            raise RuntimeError("Live blockchain transaction requires contract address and private key.")
        
        account = self._w3.eth.account.from_key(settings.BLOCKCHAIN_PRIVATE_KEY)
        root_bytes = bytes.fromhex(merkle_root.replace("0x", ""))
        
        tx = self._contract.functions.recordCheckpoint(root_bytes, batch_id, event_count).build_transaction({
            "from": account.address,
            "nonce": self._w3.eth.get_transaction_count(account.address),
            "gas": 300000,
            "gasPrice": self._w3.eth.gas_price,
            "chainId": settings.BLOCKCHAIN_CHAIN_ID,
        })
        signed_tx = self._w3.eth.account.sign_transaction(tx, settings.BLOCKCHAIN_PRIVATE_KEY)
        tx_hash = self._w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)

        return {
            "status": "CONFIRMED" if receipt.status == 1 else "FAILED",
            "transaction_hash": tx_hash.hex(),
            "block_number": receipt.blockNumber,
            "merkle_root": merkle_root,
            "is_mock": False,
        }

    def verify_checkpoint(self, merkle_root: str) -> Dict[str, Any]:
        if not self._contract:
            return {"exists": False, "is_mock": False, "error": "Contract not configured"}
        root_bytes = bytes.fromhex(merkle_root.replace("0x", ""))
        exists, batch_id, event_count, timestamp, recorder = self._contract.functions.getCheckpoint(root_bytes).call()
        return {
            "exists": exists,
            "merkle_root": merkle_root,
            "batch_id": batch_id,
            "event_count": event_count,
            "timestamp": timestamp,
            "recorder": recorder,
            "is_mock": False,
        }

    def register_identity(self, commitment: str, entity_id: str) -> Dict[str, Any]:
        if not self._contract or not settings.BLOCKCHAIN_PRIVATE_KEY:
            raise RuntimeError("Live blockchain transaction requires contract address and private key.")
        account = self._w3.eth.account.from_key(settings.BLOCKCHAIN_PRIVATE_KEY)
        cmt_bytes = bytes.fromhex(commitment.replace("0x", ""))
        tx = self._contract.functions.registerIdentityCommitment(cmt_bytes, entity_id).build_transaction({
            "from": account.address,
            "nonce": self._w3.eth.get_transaction_count(account.address),
            "gas": 300000,
            "gasPrice": self._w3.eth.gas_price,
            "chainId": settings.BLOCKCHAIN_CHAIN_ID,
        })
        signed_tx = self._w3.eth.account.sign_transaction(tx, settings.BLOCKCHAIN_PRIVATE_KEY)
        tx_hash = self._w3.eth.send_raw_transaction(signed_tx.raw_transaction)
        receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
        return {
            "status": "CONFIRMED" if receipt.status == 1 else "FAILED",
            "transaction_hash": tx_hash.hex(),
            "block_number": receipt.blockNumber,
            "is_mock": False,
        }

    def verify_identity(self, commitment: str) -> Dict[str, Any]:
        if not self._contract:
            return {"exists": False, "is_mock": False, "error": "Contract not configured"}
        cmt_bytes = bytes.fromhex(commitment.replace("0x", ""))
        exists, is_revoked, entity_id, registered_at = self._contract.functions.verifyCommitment(cmt_bytes).call()
        return {
            "exists": exists,
            "is_revoked": is_revoked,
            "entity_id": entity_id,
            "registered_at": registered_at,
            "is_mock": False,
        }


class MockBlockchainAdapter(BlockchainAdapterBase):
    """
    Simulated in-memory adapter for offline development.
    Clearly marks is_mock=True and status='SIMULATED_MOCK'.
    """
    def __init__(self):
        self._checkpoints: Dict[str, Dict[str, Any]] = {}
        self._commitments: Dict[str, Dict[str, Any]] = {}

    @property
    def is_mock(self) -> bool:
        return True

    def check_connection(self) -> Dict[str, Any]:
        return {
            "status": "mock_active",
            "is_mock": True,
            "connected": True,
            "message": "GeneaTrace is operating with local MockBlockchainAdapter (offline simulation).",
            "stored_checkpoints": len(self._checkpoints),
            "stored_commitments": len(self._commitments),
        }

    def record_checkpoint(self, merkle_root: str, batch_id: str, event_count: int) -> Dict[str, Any]:
        norm_root = merkle_root if merkle_root.startswith("0x") else f"0x{merkle_root}"
        mock_tx = f"0xmock{int(time.time()*1000):x}{len(norm_root):04x}"
        rec = {
            "exists": True,
            "merkle_root": norm_root,
            "batch_id": batch_id,
            "event_count": event_count,
            "timestamp": int(time.time()),
            "recorder": "0xMockIssuer000000000000000000000000000000",
            "transaction_hash": mock_tx,
            "block_number": 999999,
            "status": "CONFIRMED",
            "is_mock": True,
        }
        self._checkpoints[norm_root] = rec
        return rec

    def verify_checkpoint(self, merkle_root: str) -> Dict[str, Any]:
        norm_root = merkle_root if merkle_root.startswith("0x") else f"0x{merkle_root}"
        if norm_root in self._checkpoints:
            data = self._checkpoints[norm_root].copy()
            data["exists"] = True
            data["is_mock"] = True
            return data
        return {"exists": False, "merkle_root": norm_root, "is_mock": True}

    def register_identity(self, commitment: str, entity_id: str) -> Dict[str, Any]:
        norm_cmt = commitment if commitment.startswith("0x") else f"0x{commitment}"
        mock_tx = f"0xmock_id_{int(time.time()*1000):x}"
        rec = {
            "exists": True,
            "is_revoked": False,
            "entity_id": entity_id,
            "registered_at": int(time.time()),
            "transaction_hash": mock_tx,
            "is_mock": True,
        }
        self._commitments[norm_cmt] = rec
        return rec

    def verify_identity(self, commitment: str) -> Dict[str, Any]:
        norm_cmt = commitment if commitment.startswith("0x") else f"0x{commitment}"
        if norm_cmt in self._commitments:
            data = self._commitments[norm_cmt].copy()
            data["exists"] = True
            data["is_mock"] = True
            return data
        return {"exists": False, "is_revoked": False, "is_mock": True}


def get_blockchain_adapter() -> BlockchainAdapterBase:
    if settings.BLOCKCHAIN_ENABLED and settings.BLOCKCHAIN_RPC_URL:
        try:
            adapter = Web3BlockchainAdapter()
            res = adapter.check_connection()
            if res.get("connected"):
                return adapter
        except Exception as e:
            logger.warning(f"Failed to connect to EVM RPC ({str(e)}), falling back to mock adapter.")
    return MockBlockchainAdapter()


blockchain_adapter = get_blockchain_adapter()
