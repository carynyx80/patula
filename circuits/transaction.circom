pragma circom 2.0.0;

// Patula shielded pool — Phase 0 spend circuit.
// UTXO model: N input notes are spent (nullifiers published), M output notes are
// created (commitments published). Value is conserved:
//   sum(inputs) + publicAmount == sum(outputs)
// where publicAmount = extAmount - fee (mod p): positive for deposits,
// negative (wrapped) for withdrawals.
//
// Note      : commitment = Poseidon(amount, pubKey, blinding)
// Key       : pubKey     = Poseidon(privKey)
// Signature : sig        = Poseidon(privKey, commitment, pathIndex)
// Nullifier : nullifier  = Poseidon(commitment, pathIndex, sig)

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/switcher.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output root;

    component bits = Num2Bits(levels);
    bits.in <== pathIndices;

    component sw[levels];
    component h[levels];
    for (var i = 0; i < levels; i++) {
        sw[i] = Switcher();
        sw[i].L <== i == 0 ? leaf : h[i - 1].out;
        sw[i].R <== pathElements[i];
        sw[i].sel <== bits.out[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== sw[i].outL;
        h[i].inputs[1] <== sw[i].outR;
    }
    root <== h[levels - 1].out;
}

template Transaction(levels, nIns, nOuts) {
    // ---- public ----
    signal input root;
    signal input publicAmount;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    // ---- private ----
    signal input inAmount[nIns];
    signal input inPrivateKey[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPubkey[nOuts];
    signal input outBlinding[nOuts];

    component inKey[nIns];
    component inCommit[nIns];
    component inSig[nIns];
    component inNull[nIns];
    component inTree[nIns];
    component inCheckRoot[nIns];
    component inRange[nIns];
    var sumIns = 0;

    for (var i = 0; i < nIns; i++) {
        inKey[i] = Poseidon(1);
        inKey[i].inputs[0] <== inPrivateKey[i];

        inCommit[i] = Poseidon(3);
        inCommit[i].inputs[0] <== inAmount[i];
        inCommit[i].inputs[1] <== inKey[i].out;
        inCommit[i].inputs[2] <== inBlinding[i];

        inSig[i] = Poseidon(3);
        inSig[i].inputs[0] <== inPrivateKey[i];
        inSig[i].inputs[1] <== inCommit[i].out;
        inSig[i].inputs[2] <== inPathIndices[i];

        inNull[i] = Poseidon(3);
        inNull[i].inputs[0] <== inCommit[i].out;
        inNull[i].inputs[1] <== inPathIndices[i];
        inNull[i].inputs[2] <== inSig[i].out;
        inNull[i].out === inputNullifier[i];

        inTree[i] = MerkleProof(levels);
        inTree[i].leaf <== inCommit[i].out;
        inTree[i].pathIndices <== inPathIndices[i];
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
        }

        // Zero-value (dummy) inputs skip the Merkle membership check.
        inCheckRoot[i] = ForceEqualIfEnabled();
        inCheckRoot[i].in[0] <== root;
        inCheckRoot[i].in[1] <== inTree[i].root;
        inCheckRoot[i].enabled <== inAmount[i];

        inRange[i] = Num2Bits(64);
        inRange[i].in <== inAmount[i];

        sumIns += inAmount[i];
    }

    component outCommit[nOuts];
    component outRange[nOuts];
    var sumOuts = 0;
    for (var i = 0; i < nOuts; i++) {
        outCommit[i] = Poseidon(3);
        outCommit[i].inputs[0] <== outAmount[i];
        outCommit[i].inputs[1] <== outPubkey[i];
        outCommit[i].inputs[2] <== outBlinding[i];
        outCommit[i].out === outputCommitment[i];

        outRange[i] = Num2Bits(64);
        outRange[i].in <== outAmount[i];

        sumOuts += outAmount[i];
    }

    // No duplicate nullifiers within one transaction.
    component same[nIns * (nIns - 1) / 2];
    var k = 0;
    for (var i = 0; i < nIns - 1; i++) {
        for (var j = i + 1; j < nIns; j++) {
            same[k] = IsEqual();
            same[k].in[0] <== inputNullifier[i];
            same[k].in[1] <== inputNullifier[j];
            same[k].out === 0;
            k++;
        }
    }

    sumIns + publicAmount === sumOuts;

    // Bind extDataHash (recipient, relayer, amounts) into the proof.
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}

component main {public [root, publicAmount, extDataHash, inputNullifier, outputCommitment]} = Transaction(20, 2, 2);
